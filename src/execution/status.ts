import path from "node:path";

import { defaultConfigPath, resolveLogDir, resolveStateDir } from "../config.js";
import { relaymuxDbPath } from "../db.js";
import { backgroundServicePath, getLaunchAgentStatus, getLaunchAgentWatchdogStatus } from "../launch-agent.js";
import { latestEventsByRun, readRuns } from "../state.js";
import { resolveTmuxSessionMode } from "../session.js";
import { listAgentWindows } from "../tmux.js";
import { webhookStatus } from "../webhook.js";

export function handleExecutionStatus(flags, configInfo, stateDir, io, platform = process.platform) {
  const config = configInfo.config;
  const session = flags.session ? String(flags.session) : undefined;
  const windows = listAgentWindows({ session });
  const rows = buildExecutionStatusRows({ flags, stateDir, windows });
  const daemon = daemonStatus(config, configInfo.path, io.env, platform);

  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ daemon, runs: rows }, null, 2)}\n`);
    return 0;
  }

  const launchAgent: any = daemon.launchAgent;
  const launchAgentText = formatBackgroundServiceSummary(launchAgent, platform);
  const watchdog: any = daemon.launchAgentWatchdog;
  const watchdogText = formatBackgroundWatchdogSummary(watchdog, platform);
  io.stdout.write(`Home: ${daemon.homeDir}; config ${daemon.configPath}; state ${daemon.stateDir}; logs ${daemon.logDir}; db ${daemon.dbPath}\n`);
  io.stdout.write(`Background service: ${daemon.enabled ? "enabled" : "disabled"}; mode ${daemon.launchMode}/background (no tmux); ${launchAgentText}; ${watchdogText}; webhook ${daemon.webhook.endpoints.message}; token ${daemon.webhook.tokenFileExists ? daemon.webhook.tokenFileMode : "missing"}\n`);
  io.stdout.write(`Agent execution: tmux tabs/windows only; session mode ${daemon.agentSessionMode}; ${session ? `filter session ${session}` : "showing all relaymux-managed sessions"}; never panes/splits.\n`);

  if (rows.length === 0) {
    io.stdout.write(flags.history ? "No relaymux runs found.\n" : "No relaymux agent tabs found. Use --history to include old run records whose tabs are gone.\n");
    return 0;
  }

  io.stdout.write(formatTable(rows, ["state", "target", "group", "session", "tab", "agent", "name", "repo", "lastEvent"]));
  return 0;
}

export function buildExecutionStatusRows({ flags = {}, stateDir, windows = listAgentWindows({ session: flags.session ? String(flags.session) : undefined }) }: any) {
  const windowsByRunId = new Map(windows.map((window) => [window.runId, window]));
  const latestEvents = latestEventsByRun(stateDir);
  const rows = [];
  const runs = readRuns(stateDir);

  for (const run of runs) {
    if ((run.executor || "local-tmux") !== "local-tmux") continue;
    if (!flags.history && !shouldShowRunWithoutHistory(run)) continue;
    const window = windowsByRunId.get(run.runId);
    const latestEvent = latestEvents.get(run.runId);
    rows.push(statusRow(run, window, latestEvent));
  }

  for (const window of windows) {
    if (!rows.some((row) => row.runId === window.runId)) {
      rows.push(statusRow(window, window, latestEvents.get(window.runId)));
    }
  }

  rows.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return rows;
}

function shouldShowRunWithoutHistory(run) {
  return false;
}

function daemonStatus(config, configPath, env = process.env, platform = process.platform) {
  const agentSessionMode = resolveTmuxSessionMode({ config });
  return {
    enabled: config.daemon?.enabled !== false,
    homeDir: path.dirname(defaultConfigPath(env)),
    dbPath: relaymuxDbPath(env),
    configPath,
    stateDir: resolveStateDir(config, env),
    logDir: resolveLogDir(config, env),
    launchMode: "direct",
    agentSessionMode,
    featureSessionMode: agentSessionMode,
    webhook: webhookStatus(config),
    backgroundServicePath: backgroundServicePath(config, { platform, env }),
    launchAgentPath: backgroundServicePath(config, { platform, env }),
    launchAgent: getLaunchAgentStatus(config, { platform, env }),
    launchAgentWatchdog: getLaunchAgentWatchdogStatus(config, { platform, env }),
  };
}

function statusRow(run, window, latestEvent) {
  const executor = run.executor || window?.executor || "local-tmux";
  const completed = latestEvent?.event === "completed";
  const state = completed
    ? completedState(latestEvent)
    : window
      ? "running"
      : "window-missing";

  const target = window?.target || run.target || run.windowTarget || "";
  return {
    runId: run.runId,
    started: run.time || run.started,
    state,
    executor,
    target,
    group: run.group || window?.group || run.session || "",
    session: window?.session || run.session || targetSession(target),
    tab: window ? `${window.windowIndex}:${window.windowName}` : targetTab(target),
    agent: run.agent || window?.agent || "",
    name: run.name || window?.name || "",
    repo: run.repo || window?.repo || "",
    workdir: run.workdir || window?.cwd || "",
    logs: run.stdoutLog || run.logPath || "",
    stdoutLog: run.stdoutLog || "",
    stderrLog: run.stderrLog || "",
    lastEvent: formatLastEvent(latestEvent),
  };
}

function completedState(event) {
  const code = event.exitCode;
  if (code === undefined || code === null || code === "") return "completed";
  const number = Number(code);
  return number === 0 ? "completed:0" : `failed:${code}`;
}

function formatLastEvent(event) {
  if (!event) return "";
  const code = event.exitCode === undefined ? "" : `:${event.exitCode}`;
  const message = event.message ? ` ${event.message}` : "";
  return `${event.event}${code}${message}`;
}

function targetSession(target) {
  return String(target || "").split(":")[0] || "";
}

function targetTab(target) {
  const text = String(target || "");
  if (text.startsWith("pid:")) return "";
  const tab = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  return tab.replace(/\.\d+$/, "");
}

function formatBackgroundServiceSummary(status, platform) {
  if (status.serviceManager === "systemd") {
    if (!status.supported) return `systemd user service ${status.serviceName} unavailable`;
    return status.loaded
      ? `systemd user service ${status.serviceName} active${status.running && status.pid ? ` pid=${status.pid}` : ""}`
      : `systemd user service ${status.serviceName} not active`;
  }
  if (status.serviceManager === "launchd" || platform === "darwin") {
    return status.supported
      ? status.loaded
        ? `LaunchAgent ${status.label} loaded${status.running ? ` pid=${status.pid}` : ""}`
        : `LaunchAgent ${status.label} not loaded`
      : `LaunchAgent unsupported on ${platform}`;
  }
  return `background service unsupported on ${platform}`;
}

function formatBackgroundWatchdogSummary(watchdog, platform) {
  if (platform === "linux") return "restart policy systemd Restart=always";
  if (watchdog?.enabled) {
    return watchdog.loaded
      ? `watchdog ${watchdog.label} loaded every ${watchdog.intervalSeconds}s`
      : `watchdog ${watchdog.label} not loaded`;
  }
  return "watchdog disabled";
}

function formatTable(rows, columns) {
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
