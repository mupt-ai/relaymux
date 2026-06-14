import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { quoteArgv, shellQuote } from "./command.js";
import { resolveLogDir } from "./config.js";
import {
  defaultLaunchPath,
  launchAgentDomain,
  launchAgentLabel,
  renderLaunchAgentPlist,
  stableNodePath,
} from "./launch-agent.js";
import { expandPath, ensureDirectory, readTextFile } from "./paths.js";
import { runCommand } from "./process.js";
import { isReplyMode, replyModesText } from "./reply-modes.js";

const MAX_SCHEDULE_NAME_LENGTH = 80;
const MAX_CALENDAR_INTERVALS = 512;
const SCHEDULE_BACKENDS = new Set(["auto", "launchd", "cron"]);

const MONTH_NAMES = new Map([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

const WEEKDAY_NAMES = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

const CRON_ALIASES = new Map([
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
]);

const CRON_FIELDS = [
  { name: "minute", key: "Minute", min: 0, max: 59 },
  { name: "hour", key: "Hour", min: 0, max: 23 },
  { name: "day of month", key: "Day", min: 1, max: 31 },
  { name: "month", key: "Month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day of week", key: "Weekday", min: 0, max: 7, names: WEEKDAY_NAMES },
];

export function handleSchedule({ flags, positionals, configInfo, stateDir, binPath, io }) {
  const action = String(positionals[0] || "help");

  switch (action) {
    case "add":
      return handleScheduleAdd({ flags, configInfo, stateDir, binPath, io });
    case "list":
      return handleScheduleList({ flags, stateDir, io });
    case "remove":
    case "rm":
      return handleScheduleRemove({ flags, positionals, configInfo, stateDir, io });
    case "help":
      io.stdout.write(scheduleHelpText());
      return 0;
    default:
      throw new Error(`Unknown schedule command "${action}". Use relaymux schedule --help.`);
  }
}

export function scheduleHelpText() {
  return `relaymux schedule - install local recurring orchestrator prompts

Scheduled prompts use the OS scheduler to invoke relaymux locally. relaymux does
not run a durable in-process scheduler loop.

Usage:
  relaymux schedule add --name <name> --prompt <text> --cron "0 9 * * *" [--reply-mode none|imessage|telegram] [--scheduler auto|launchd|cron]
  relaymux schedule add --name <name> --prompt-file <path> --cron "0 9 * * *" [--dry-run]
  relaymux schedule list [--json]
  relaymux schedule remove --name <name> [--dry-run]

Options:
  --name <name>          Stable id for this schedule; re-adding the same name updates it
  --prompt <text>        Prompt text to copy into private relaymux state
  --prompt-file <path>   Read prompt text from a file and copy it into relaymux state
  --cron <expr>          Five-field cron expression, for example "0 9 * * *"
  --reply-mode <mode>    none, imessage, or telegram (default none)
  --scheduler <backend>  auto, launchd, or cron (default auto)
  --dry-run              Print generated job without writing or installing it
  --no-load              Write schedule files without installing/loading the OS job
  --json                 For list: print schedule metadata as JSON

auto uses per-user launchd LaunchAgents on macOS and cron elsewhere. The scheduled
job calls relaymux ask --no-wait, so the relaymux daemon must be running when the
schedule fires.
`;
}

function handleScheduleAdd({ flags, configInfo, stateDir, binPath, io }) {
  if (!configInfo.exists) {
    throw new Error(`Config does not exist at ${configInfo.path}. Run relaymux setup first.`);
  }

  const prompt = resolveSchedulePrompt(flags);
  const plan = buildScheduledPromptPlan({
    name: flags.name,
    cron: flags.cron,
    prompt,
    replyMode: flags.replyMode,
    scheduler: flags.scheduler,
    config: configInfo.config,
    configPath: configInfo.path,
    stateDir,
    binPath,
  });

  if (flags.dryRun) {
    io.stdout.write(formatScheduleDryRun(plan));
    return 0;
  }

  const existing = readScheduleMetadata(plan.metadataFile);
  const now = new Date().toISOString();
  const metadata = {
    ...plan.metadata,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  writeSchedulePlan(plan, prompt, metadata, io);

  if (flags.load === false) {
    io.stdout.write(`Schedule ${plan.name} written but not installed. ${plan.installHint}\n`);
    return 0;
  }

  installSchedulePlan(plan, io);
  io.stdout.write(`Installed schedule ${plan.name} with ${plan.scheduler}\n`);
  io.stdout.write("Requires the relaymux daemon to be running when the schedule fires; use `relaymux restart-launch-agent` if needed.\n");
  return 0;
}

function handleScheduleList({ flags, stateDir, io }) {
  const schedules = listScheduledPrompts(stateDir);
  if (flags.json) {
    io.stdout.write(`${JSON.stringify(schedules, null, 2)}\n`);
    return 0;
  }

  if (!schedules.length) {
    io.stdout.write("No scheduled prompts found.\n");
    return 0;
  }

  io.stdout.write(formatScheduleTable(schedules));
  return 0;
}

function handleScheduleRemove({ flags, positionals, configInfo, stateDir, io }) {
  const name = normalizeScheduleName(flags.name || positionals[1]);
  const existing = readScheduleMetadata(scheduleMetadataPath(stateDir, name));
  const scheduler = existing?.scheduler || resolveScheduleBackend(flags.scheduler);
  const label = existing?.label || (scheduler === "launchd" ? scheduleLaunchAgentLabel(configInfo.config, name) : "");
  const plistPath = existing?.plistPath || (label ? scheduleLaunchAgentPath(label) : "");
  const scheduleDir = scheduleDirectory(stateDir, name);

  if (flags.dryRun) {
    if (scheduler === "launchd") {
      io.stdout.write(`# would unload ${launchAgentTarget(label)}\n`);
      io.stdout.write(`# would remove ${plistPath}\n`);
    } else {
      io.stdout.write(`# would remove crontab entry containing ${existing?.marker || cronMarker(name)}\n`);
    }
    io.stdout.write(`# would remove ${scheduleDir}\n`);
    return 0;
  }

  if (scheduler === "launchd") {
    removeLaunchdSchedule({ label, plistPath, io });
  } else {
    removeCronSchedule({ marker: existing?.marker || cronMarker(name), io });
  }
  if (fs.existsSync(scheduleDir)) {
    fs.rmSync(scheduleDir, { recursive: true, force: true });
    io.stdout.write(`Removed ${scheduleDir}\n`);
  } else {
    io.stdout.write(`No schedule state found at ${scheduleDir}\n`);
  }
  return 0;
}

export function buildScheduledPromptPlan({ name, cron, prompt, replyMode = "none", scheduler = "auto", platform = process.platform, config, configPath, stateDir, binPath }) {
  const normalizedName = normalizeScheduleName(name);
  const resolvedScheduler = resolveScheduleBackend(scheduler, platform);
  const parsedCron = parseCronExpression(cron, { forLaunchd: resolvedScheduler === "launchd" });
  const resolvedReplyMode = String(replyMode || "none");
  if (!isReplyMode(resolvedReplyMode)) {
    throw new Error(`--reply-mode must be ${replyModesText()}`);
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Scheduled prompt cannot be empty.");
  }

  const scheduleDir = scheduleDirectory(stateDir, normalizedName);
  const promptFile = path.join(scheduleDir, "prompt.txt");
  const metadataFile = path.join(scheduleDir, "schedule.json");
  const scheduleLogDir = path.join(resolveLogDir(config), "schedules");
  const standardOutPath = path.join(scheduleLogDir, `${normalizedName}.out.log`);
  const standardErrorPath = path.join(scheduleLogDir, `${normalizedName}.err.log`);
  const programArguments = [
    stableNodePath(),
    binPath,
    "--config",
    configPath,
    "ask",
    "--no-wait",
    "--from",
    `schedule:${normalizedName}`,
    "--reply-mode",
    resolvedReplyMode,
    "--prompt-file",
    promptFile,
  ];
  const context = {
    name: normalizedName,
    cron: parsedCron,
    replyMode: resolvedReplyMode,
    scheduler: resolvedScheduler,
    scheduleDir,
    promptFile,
    metadataFile,
    standardOutPath,
    standardErrorPath,
    programArguments,
    config,
    configPath,
  };

  return resolvedScheduler === "launchd"
    ? buildLaunchdScheduledPromptPlan(context)
    : buildCronScheduledPromptPlan(context);
}

function buildLaunchdScheduledPromptPlan(context) {
  const label = scheduleLaunchAgentLabel(context.config, context.name);
  const plistPath = scheduleLaunchAgentPath(label);
  const plist = renderLaunchAgentPlist({
    label,
    programArguments: context.programArguments,
    workingDirectory: os.homedir(),
    environment: {
      PATH: defaultLaunchPath(),
      HOME: os.homedir(),
      RELAYMUX_CONFIG: context.configPath,
    },
    standardOutPath: context.standardOutPath,
    standardErrorPath: context.standardErrorPath,
    keepAlive: false,
    runAtLoad: false,
    startCalendarIntervals: context.cron.launchd,
  });

  const metadata = {
    version: 1,
    name: context.name,
    cron: context.cron.original,
    expandedCron: context.cron.expanded,
    replyMode: context.replyMode,
    promptFile: context.promptFile,
    configPath: context.configPath,
    label,
    plistPath,
    standardOutPath: context.standardOutPath,
    standardErrorPath: context.standardErrorPath,
    program: quoteArgv(context.programArguments),
    scheduler: "launchd",
  };

  return {
    ...context,
    label,
    plistPath,
    plist,
    metadata,
    installHint: `Load with: launchctl bootstrap ${launchAgentDomain()} ${plistPath}`,
  };
}

function buildCronScheduledPromptPlan(context) {
  const marker = cronMarker(context.name);
  const command = escapeCronCommand(`${quoteArgv(context.programArguments)} >> ${shellQuote(context.standardOutPath)} 2>> ${shellQuote(context.standardErrorPath)}`);
  const cronLine = `${context.cron.expanded} ${command} ${marker}`;
  const metadata = {
    version: 1,
    name: context.name,
    cron: context.cron.original,
    expandedCron: context.cron.expanded,
    replyMode: context.replyMode,
    promptFile: context.promptFile,
    configPath: context.configPath,
    standardOutPath: context.standardOutPath,
    standardErrorPath: context.standardErrorPath,
    program: quoteArgv(context.programArguments),
    scheduler: "cron",
    marker,
    cronLine,
  };

  return {
    ...context,
    marker,
    cronLine,
    metadata,
    installHint: "Install by re-running without --no-load, or add the generated crontab entry manually.",
  };
}

function writeSchedulePlan(plan, prompt, metadata, io) {
  ensureDirectory(plan.scheduleDir);
  try { fs.chmodSync(plan.scheduleDir, 0o700); } catch {}
  ensureDirectory(path.dirname(plan.standardOutPath));
  writePrivateFile(plan.promptFile, `${prompt.trimEnd()}\n`);
  writePrivateFile(plan.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);

  io.stdout.write(`Wrote ${plan.promptFile}\n`);
  io.stdout.write(`Wrote ${plan.metadataFile}\n`);

  if (plan.scheduler === "launchd") {
    ensureDirectory(path.dirname(plan.plistPath));
    fs.writeFileSync(plan.plistPath, plan.plist, { mode: 0o644 });
    io.stdout.write(`Wrote ${plan.plistPath}\n`);
  }
}

function installSchedulePlan(plan, io) {
  if (plan.scheduler === "launchd") {
    loadScheduleLaunchAgent(plan);
    io.stdout.write(`Loaded LaunchAgent ${plan.label}\n`);
    return;
  }

  installCronSchedule(plan, io);
}

function resolveScheduleBackend(value = "auto", platform = process.platform) {
  const requested = String(value || "auto").trim().toLowerCase();
  if (!SCHEDULE_BACKENDS.has(requested)) {
    throw new Error(`--scheduler must be auto, launchd, or cron`);
  }
  if (requested !== "auto") return requested;
  return platform === "darwin" ? "launchd" : "cron";
}

export function parseCronExpression(raw, { forLaunchd = true } = {}) {
  const original = String(raw || "").trim();
  if (!original) {
    throw new Error("Missing --cron <expr>");
  }

  const expanded = CRON_ALIASES.get(original.toLowerCase()) || original;
  if (original.startsWith("@") && !CRON_ALIASES.has(original.toLowerCase())) {
    throw new Error(`Unsupported cron alias "${original}". Use a five-field cron expression.`);
  }

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have five fields: minute hour day-of-month month day-of-week (got ${parts.length}).`);
  }

  const fields = CRON_FIELDS.map((field, index) => ({
    ...field,
    values: parseCronField(parts[index], field),
  }));
  if (!forLaunchd) {
    return {
      original,
      expanded,
      launchd: [],
    };
  }

  const dayOfMonth = fields[2].values;
  const dayOfWeek = fields[4].values;
  if (dayOfMonth && dayOfWeek) {
    throw new Error("Cron expressions that constrain both day-of-month and day-of-week are not supported because launchd uses stricter matching than cron.");
  }

  let specified = fields.filter((field) => field.values);
  if (!specified.length) {
    specified = [{ ...fields[0], values: range(0, 59) }];
  }

  let launchd = [{}];
  for (const field of specified) {
    const next = [];
    for (const interval of launchd) {
      for (const value of field.values) {
        next.push({ ...interval, [field.key]: value });
      }
    }
    launchd = next;
    if (launchd.length > MAX_CALENDAR_INTERVALS) {
      throw new Error(`Cron expression expands to ${launchd.length} launchd calendar intervals; keep it at ${MAX_CALENDAR_INTERVALS} or fewer.`);
    }
  }

  return {
    original,
    expanded,
    launchd,
  };
}

export function listScheduledPrompts(stateDir) {
  const root = path.join(stateDir, "schedules");
  if (!fs.existsSync(root)) return [];
  const crontab = readCrontab({ allowUnavailable: true }).text;

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readScheduleMetadata(path.join(root, entry.name, "schedule.json")))
    .filter(Boolean)
    .map((metadata) => ({
      ...metadata,
      installed: isScheduleInstalled(metadata, crontab),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function normalizeScheduleName(value) {
  const name = String(value || "").trim();
  if (!name) {
    throw new Error("Missing --name <name>");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.length > MAX_SCHEDULE_NAME_LENGTH) {
    throw new Error(`--name must start with a letter or number and contain only letters, numbers, dots, underscores, and dashes (${MAX_SCHEDULE_NAME_LENGTH} chars max).`);
  }
  return name;
}

function resolveSchedulePrompt(flags) {
  if (flags.prompt !== undefined && flags.promptFile) {
    throw new Error("Use either --prompt or --prompt-file, not both.");
  }
  if (flags.promptFile) {
    return readTextFile(expandPath(flags.promptFile));
  }
  if (flags.prompt === undefined) {
    throw new Error("Missing --prompt <text> or --prompt-file <path>");
  }
  return String(flags.prompt);
}

function parseCronField(raw, field) {
  const text = String(raw || "").trim().toLowerCase();
  if (text === "*") return null;
  if (!text) throw new Error(`Cron ${field.name} field is empty.`);

  const values = new Set();
  for (const part of text.split(",")) {
    addCronFieldPart(values, part.trim(), field);
  }
  return Array.from(values).sort((a: number, b: number) => a - b);
}

function addCronFieldPart(values, part, field) {
  if (!part) throw new Error(`Cron ${field.name} field contains an empty list item.`);

  const pieces = part.split("/");
  if (pieces.length > 2) {
    throw new Error(`Invalid cron ${field.name} segment "${part}".`);
  }
  const rangePart = pieces[0];
  const step = pieces[1] === undefined ? 1 : parsePositiveInteger(pieces[1], `${field.name} step`);
  if (step < 1) throw new Error(`Cron ${field.name} step must be at least 1.`);

  let start;
  let end;
  if (rangePart === "*") {
    start = field.min;
    end = field.max;
  } else if (rangePart.includes("-")) {
    const bounds = rangePart.split("-");
    if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
      throw new Error(`Invalid cron ${field.name} range "${rangePart}".`);
    }
    start = parseCronValue(bounds[0], field);
    end = parseCronValue(bounds[1], field);
    if (start > end) {
      throw new Error(`Cron ${field.name} range "${rangePart}" must not descend.`);
    }
  } else {
    start = parseCronValue(rangePart, field);
    end = start;
  }

  for (let value = start; value <= end; value += step) {
    values.add(normalizeCronValue(value, field));
  }
}

function parseCronValue(raw, field) {
  const named = field.names?.get(String(raw).toLowerCase());
  if (named !== undefined) return named;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid cron ${field.name} value "${raw}".`);
  }
  if (value < field.min || value > field.max) {
    throw new Error(`Cron ${field.name} value ${value} is outside ${field.min}-${field.max}.`);
  }
  return value;
}

function normalizeCronValue(value, field) {
  if (field.key === "Weekday" && value === 7) return 0;
  return value;
}

function parsePositiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return value;
}

function range(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}

function loadScheduleLaunchAgent(plan) {
  if (process.platform !== "darwin") {
    throw new Error("launchd schedule install requires macOS. Use --scheduler cron or --dry-run.");
  }
  const domain = launchAgentDomain();
  const target = launchAgentTarget(plan.label);
  runCommand("launchctl", ["bootout", target], { allowFailure: true });
  runCommand("launchctl", ["enable", target], { allowFailure: true });
  const result = runCommand("launchctl", ["bootstrap", domain, plan.plistPath], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed for ${plan.label}: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`}`);
  }
}

function removeLaunchdSchedule({ label, plistPath, io }) {
  if (process.platform === "darwin" && label) {
    runCommand("launchctl", ["bootout", launchAgentTarget(label)], { allowFailure: true });
  }
  if (plistPath && fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    io.stdout.write(`Removed ${plistPath}\n`);
  } else {
    io.stdout.write(`No LaunchAgent found at ${plistPath || "(unknown)"}\n`);
  }
}

function installCronSchedule(plan, io) {
  const current = readCrontab({ allowUnavailable: false });
  const next = replaceCronMarker(current.text, plan.marker, plan.cronLine);
  const result = runCommand("crontab", ["-"], {
    allowFailure: true,
    input: next,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`crontab install failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`}`);
  }
  io.stdout.write(`Installed crontab entry for ${plan.name}\n`);
}

function removeCronSchedule({ marker, io }) {
  const current = readCrontab({ allowUnavailable: true });
  if (!current.available) {
    io.stdout.write("No crontab command available; skipped crontab removal.\n");
    return;
  }
  const lines = current.text.split(/\r?\n/);
  const kept = lines.filter((line) => !line.includes(marker));
  if (kept.length === lines.length) {
    io.stdout.write(`No crontab entry found for ${marker}\n`);
    return;
  }
  const next = normalizeCrontabText(kept.join("\n"));
  const result = runCommand("crontab", ["-"], {
    allowFailure: true,
    input: next,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`crontab removal failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`}`);
  }
  io.stdout.write(`Removed crontab entry for ${marker}\n`);
}

function readCrontab({ allowUnavailable }) {
  const result = runCommand("crontab", ["-l"], { allowFailure: true });
  if (result.status === 0) {
    return { available: true, text: normalizeCrontabText(result.stdout) };
  }
  const detail = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
  const hasNoCrontab = detail.includes("no crontab") || detail.includes("no crontab for");
  if (hasNoCrontab) {
    return { available: true, text: "" };
  }
  if (allowUnavailable) {
    return { available: false, text: "" };
  }
  throw new Error(`Could not read crontab: ${firstLine(result.stderr) || firstLine(result.stdout) || result.error?.message || `exit ${result.status}`}`);
}

function replaceCronMarker(currentText, marker, cronLine) {
  const lines = currentText.split(/\r?\n/).filter((line) => line && !line.includes(marker));
  lines.push(cronLine);
  return normalizeCrontabText(lines.join("\n"));
}

function isScheduleInstalled(metadata, crontabText) {
  if (metadata.scheduler === "cron") {
    return Boolean(metadata.marker && crontabText.includes(metadata.marker));
  }
  return Boolean(metadata.plistPath && fs.existsSync(metadata.plistPath));
}

function normalizeCrontabText(value) {
  const trimmed = String(value || "").replace(/\s+$/g, "");
  return trimmed ? `${trimmed}\n` : "";
}

function formatScheduleDryRun(plan) {
  const lines = [
    `# schedule: ${plan.name}`,
    `# scheduler: ${plan.scheduler}`,
    `# cron: ${plan.cron.original}${plan.cron.expanded !== plan.cron.original ? ` (${plan.cron.expanded})` : ""}`,
    `# prompt file: ${plan.promptFile}`,
    `# metadata: ${plan.metadataFile}`,
    `# command: ${plan.metadata.program}`,
  ];

  if (plan.scheduler === "launchd") {
    lines.push(`# LaunchAgent: ${plan.plistPath}`, plan.plist);
  } else {
    lines.push("# crontab entry", plan.cronLine);
  }

  return lines.join("\n");
}

function formatScheduleTable(schedules) {
  const rows = schedules.map((schedule) => ({
    name: schedule.name,
    cron: schedule.cron,
    reply: schedule.replyMode,
    installed: schedule.installed ? "yes" : "no",
    updated: schedule.updatedAt || "",
  }));
  const columns = ["name", "cron", "reply", "installed", "updated"];
  const headers = columns.map((column) => column.toUpperCase());
  const widths = columns.map((column, index) =>
    Math.max(headers[index].length, ...rows.map((row) => String(row[column] ?? "").length)),
  );
  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
  ];

  for (const row of rows) {
    lines.push(columns.map((column, index) => String(row[column] ?? "").padEnd(widths[index])).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

function readScheduleMetadata(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writePrivateFile(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function scheduleDirectory(stateDir, name) {
  return path.join(stateDir, "schedules", name);
}

function scheduleMetadataPath(stateDir, name) {
  return path.join(scheduleDirectory(stateDir, name), "schedule.json");
}

function scheduleLaunchAgentLabel(config, name) {
  return `${launchAgentLabel(config)}.schedule.${name}`;
}

function scheduleLaunchAgentPath(label) {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function launchAgentTarget(label) {
  return `${launchAgentDomain()}/${label}`;
}

function cronMarker(name) {
  return `# relaymux schedule:${name}`;
}

function escapeCronCommand(command) {
  return String(command).replaceAll("%", "\\%");
}

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/)[0] || "";
}
