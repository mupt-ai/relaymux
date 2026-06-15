import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";
import { defaultConfig, writeConfig } from "../src/config.js";
import { buildScheduledPromptPlan, normalizeScheduleName, parseCronExpression } from "../src/schedule.js";

function makeIo(env: Record<string, string> = {}, platform = process.platform) {
  let stdout = "";
  let stderr = "";
  const baseEnv = { ...process.env };
  delete baseEnv.RELAYMUX_SESSION;
  return {
    io: {
      env: { ...baseEnv, ...env },
      platform,
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function writeScheduleTestConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-schedule-"));
  const env = { RELAYMUX_HOME: path.join(root, "home") };
  const configPath = path.join(root, "config.json");
  const config = {
    ...defaultConfig(env),
    stateDir: path.join(root, "state"),
    daemon: {
      ...defaultConfig(env).daemon,
      logDir: path.join(root, "logs"),
      launchAgentLabel: "com.example.relaymux",
    },
  };
  writeConfig(configPath, config, { env });
  return { root, env, config, configPath };
}

test("parseCronExpression converts a daily cron to launchd calendar keys", () => {
  const parsed = parseCronExpression("0 9 * * *");

  assert.equal(parsed.original, "0 9 * * *");
  assert.deepEqual(parsed.launchd, [{ Minute: 0, Hour: 9 }]);
});

test("parseCronExpression supports aliases, names, and steps", () => {
  const daily = parseCronExpression("@daily");
  const weekdays = parseCronExpression("*/30 8-9 * jan mon-fri");

  assert.deepEqual(daily.launchd, [{ Minute: 0, Hour: 0 }]);
  assert.equal(weekdays.launchd.length, 20);
  assert.ok(weekdays.launchd.some((item) => item.Minute === 30 && item.Hour === 9 && item.Month === 1 && item.Weekday === 5));
});

test("parseCronExpression rejects launchd/cron day matching ambiguity", () => {
  assert.throws(
    () => parseCronExpression("0 9 1 * mon"),
    /day-of-month and day-of-week/,
  );
});

test("parseCronExpression allows cron day matching when launchd output is not needed", () => {
  const parsed = parseCronExpression("0 9 1 * mon", { forLaunchd: false });

  assert.equal(parsed.expanded, "0 9 1 * mon");
  assert.deepEqual(parsed.launchd, []);
});

test("normalizeScheduleName keeps schedule identifiers predictable", () => {
  assert.equal(normalizeScheduleName("daily-check"), "daily-check");
  assert.throws(() => normalizeScheduleName("daily check"), /letters, numbers/);
});

test("buildScheduledPromptPlan keeps prompt text out of the LaunchAgent plist", () => {
  const { config, configPath, root } = writeScheduleTestConfig();
  const plan = buildScheduledPromptPlan({
    name: "daily-check",
    cron: "0 9 * * *",
    prompt: "secret prompt text",
    replyMode: "telegram",
    scheduler: "launchd",
    config,
    configPath,
    stateDir: path.join(root, "state"),
    binPath: "/tmp/relaymux.js",
  });

  assert.equal(plan.label, "com.example.relaymux.schedule.daily-check");
  assert.match(plan.plist, /<key>RunAtLoad<\/key>\n  <false\/>/);
  assert.match(plan.plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plan.plist, /<string>ask<\/string>/);
  assert.match(plan.plist, /<string>--no-wait<\/string>/);
  assert.match(plan.plist, /<string>--prompt-file<\/string>/);
  assert.match(plan.plist, /daily-check\/prompt\.txt/);
  assert.doesNotMatch(plan.plist, /secret prompt text/);
});

test("buildScheduledPromptPlan can generate a cron backend without launchd fields", () => {
  const { config, configPath, root } = writeScheduleTestConfig();
  const plan = buildScheduledPromptPlan({
    name: "daily-check",
    cron: "0 9 1 * mon",
    prompt: "secret prompt text",
    replyMode: "none",
    scheduler: "cron",
    config,
    configPath,
    stateDir: path.join(root, "state"),
    binPath: "/tmp/relaymux.js",
  });

  assert.equal(plan.scheduler, "cron");
  assert.match(plan.cronLine, /^0 9 1 \* mon /);
  assert.match(plan.cronLine, /# relaymux schedule:daily-check$/);
  assert.match(plan.cronLine, /--prompt-file/);
  assert.doesNotMatch(plan.cronLine, /secret prompt text/);
});

test("buildScheduledPromptPlan escapes percent characters for crontab commands", () => {
  const { config, root } = writeScheduleTestConfig();
  const plan = buildScheduledPromptPlan({
    name: "daily-check",
    cron: "0 9 * * *",
    prompt: "hello",
    scheduler: "cron",
    config: {
      ...config,
      daemon: {
        ...config.daemon,
        logDir: path.join(root, "logs%cron"),
      },
    },
    configPath: path.join(root, "relaymux%config.json"),
    stateDir: path.join(root, "state"),
    binPath: "/tmp/relaymux.js",
  });

  assert.match(plan.cronLine, /relaymux\\%config\.json/);
  assert.match(plan.cronLine, /logs\\%cron/);
});

test("buildScheduledPromptPlan auto-selects cron off macOS", () => {
  const { config, configPath, root } = writeScheduleTestConfig();
  const plan = buildScheduledPromptPlan({
    name: "daily-check",
    cron: "0 9 * * *",
    prompt: "hello",
    scheduler: "auto",
    platform: "linux",
    config,
    configPath,
    stateDir: path.join(root, "state"),
    binPath: "/tmp/relaymux.js",
  });

  assert.equal(plan.scheduler, "cron");
});

test("schedule add dry-run prints the planned launchd job without writing state", async () => {
  const { configPath, env, root } = writeScheduleTestConfig();
  const harness = makeIo(env);
  const code = await main([
    "--config",
    configPath,
    "schedule",
    "add",
    "--name",
    "daily-check",
    "--prompt",
    "secret prompt text",
    "--cron",
    "0 9 * * *",
    "--scheduler",
    "launchd",
    "--reply-mode",
    "none",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# schedule: daily-check/);
  assert.match(harness.stdout, /StartCalendarInterval/);
  assert.match(harness.stdout, /--prompt-file/);
  assert.doesNotMatch(harness.stdout, /secret prompt text/);
  assert.equal(fs.existsSync(path.join(root, "state", "schedules", "daily-check")), false);
});

test("schedule add dry-run can print a cron job without writing state", async () => {
  const { configPath, env, root } = writeScheduleTestConfig();
  const harness = makeIo(env);  const code = await main([
    "--config",
    configPath,
    "schedule",
    "add",
    "--name",
    "daily-check",
    "--prompt",
    "secret prompt text",
    "--cron",
    "0 9 1 * mon",
    "--scheduler",
    "cron",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# scheduler: cron/);
  assert.match(harness.stdout, /# crontab entry/);
  assert.match(harness.stdout, /# relaymux schedule:daily-check/);
  assert.doesNotMatch(harness.stdout, /secret prompt text/);
  assert.equal(fs.existsSync(path.join(root, "state", "schedules", "daily-check")), false);
});

test("schedule add dry-run auto-selects cron with Linux platform wording", async () => {
  const { configPath, env, root } = writeScheduleTestConfig();
  const harness = makeIo(env, "linux");
  const code = await main([
    "--config",
    configPath,
    "schedule",
    "add",
    "--name",
    "daily-check",
    "--prompt",
    "secret prompt text",
    "--cron",
    "0 9 * * *",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# scheduler: cron/);
  assert.match(harness.stdout, /# crontab entry/);
  assert.doesNotMatch(harness.stdout, /LaunchAgent/);
  assert.equal(fs.existsSync(path.join(root, "state", "schedules", "daily-check")), false);
});

test("schedule remove dry-run prints the launchd and state targets", async () => {
  const { configPath, env, root } = writeScheduleTestConfig();
  const harness = makeIo(env);
  const code = await main([
    "--config",
    configPath,
    "schedule",
    "remove",
    "--name",
    "daily-check",
    "--scheduler",
    "launchd",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# would unload .*com\.example\.relaymux\.schedule\.daily-check/);
  assert.match(harness.stdout, new RegExp(`${path.join(root, "state", "schedules", "daily-check").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("schedule remove dry-run can target a cron marker", async () => {
  const { configPath, env } = writeScheduleTestConfig();
  const harness = makeIo(env);
  const code = await main([
    "--config",
    configPath,
    "schedule",
    "remove",
    "--name",
    "daily-check",
    "--scheduler",
    "cron",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# would remove crontab entry containing # relaymux schedule:daily-check/);
});

test("schedule help has a dedicated page", async () => {
  const harness = makeIo();
  const code = await main(["schedule", "--help"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /relaymux schedule - install local recurring orchestrator prompts/);
  assert.match(harness.stdout, /relaymux schedule add/);
});
