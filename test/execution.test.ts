import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { quoteArgv } from "../src/command.js";
import { defaultConfig, writeConfig } from "../src/config.js";
import { main } from "../src/cli.js";
import { resolveAgentConfig } from "../src/execution/agents.js";
import { launchLocalBackground } from "../src/execution/local-background.js";
import { resolveExecutorName } from "../src/execution/selection.js";
import { buildExecutionStatusRows } from "../src/execution/status.js";
import { latestEventsByRun, readRuns } from "../src/state.js";

function makeIo(env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      env: { ...process.env, ...env },
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function makeFakeNotifyCli(dir: string) {
  const file = path.join(dir, "fake-relaymux-notify.mjs");
  fs.writeFileSync(file, `import fs from "node:fs";
import path from "node:path";
const stateDir = process.env.RELAYMUX_TEST_STATE_DIR;
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const event = {
  time: new Date().toISOString(),
  runId: value("--run-id"),
  event: value("--event") || "message",
  exitCode: value("--exit-code") === undefined ? undefined : Number(value("--exit-code")),
  message: value("--message") || "",
  agent: value("--agent") || "",
  name: value("--name") || "",
  repo: value("--repo") || "",
};
fs.mkdirSync(stateDir, { recursive: true });
fs.appendFileSync(path.join(stateDir, "events.jsonl"), JSON.stringify(event) + "\\n");
`);
  return file;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), "condition did not become true before timeout");
}

test("cc agent alias resolves to configured Claude Code agent", () => {
  const config = defaultConfig();

  const resolved = resolveAgentConfig(config, "cc");

  assert.equal(resolved.agentName, "claude");
  assert.equal(resolved.requestedAgent, "cc");
  assert.deepEqual(resolved.agentConfig.command, config.agents.claude.command);
});

test("executor aliases normalize to canonical backends", () => {
  assert.equal(resolveExecutorName({ flags: { mode: "tmux" } }), "local-tmux");
  assert.equal(resolveExecutorName({ flags: { executor: "background" } }), "local-background");
  assert.equal(resolveExecutorName({ flags: { mode: "cloud" } }), "cloud-sandbox");
});

test("local background backend detaches, writes logs, and records lifecycle events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-bg-"));
  const stateDir = path.join(root, "state");
  const fakeCli = makeFakeNotifyCli(root);
  const harness = makeIo({ RELAYMUX_TEST_STATE_DIR: stateDir });

  const result = launchLocalBackground({
    agentConfig: {
      command: ["sh", "-lc", "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2; exit 3"],
      promptMode: "none",
    },
    agentName: "custom",
    requestedAgent: "custom",
    cliPath: fakeCli,
    config: {},
    configPath: path.join(root, "config.json"),
    dryRun: false,
    env: harness.io.env,
    executor: "local-background",
    group: "batch-a",
    holdOnExit: false,
    io: harness.io,
    launchNotification: { onExit: "never", replyMode: "none", tailLines: 80, tailBytes: 4000 },
    name: "bg-test",
    printCommand: false,
    prompt: "noop",
    quoteArgv,
    repo: root,
    requestedBy: "test",
    runId: "run-bg-test",
    session: "batch-a",
    sessionInfo: null,
    stateDir,
    workdir: root,
  });

  await waitFor(() => latestEventsByRun(stateDir).get("run-bg-test")?.event === "completed");

  const runs = readRuns(stateDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].executor, "local-background");
  assert.equal(runs[0].group, "batch-a");
  assert.equal(runs[0].pid, result.pid);
  assert.match(harness.stdout, /Started bg-test as local background process/);
  assert.match(fs.readFileSync(result.logs.stdoutLog, "utf8"), /stdout-line/);
  assert.match(fs.readFileSync(result.logs.stderrLog, "utf8"), /stderr-line/);

  const latest = latestEventsByRun(stateDir).get("run-bg-test");
  assert.equal(latest.event, "completed");
  assert.equal(latest.exitCode, 3);

  const rows = buildExecutionStatusRows({ flags: {}, stateDir, windows: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].executor, "local-background");
  assert.equal(rows[0].state, "failed:3");
  assert.equal(rows[0].session, "");
  assert.equal(rows[0].logs, result.logs.stdoutLog);
});

test("cloud sandbox executor fails closed when unconfigured", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-cloud-"));
  const configPath = path.join(root, "config.json");
  const config = {
    ...defaultConfig({ RELAYMUX_HOME: path.join(root, "home") }),
    stateDir: path.join(root, "state"),
  };
  writeConfig(configPath, config);
  const harness = makeIo();

  const code = await main([
    "--config",
    configPath,
    "launch",
    "--repo",
    root,
    "--agent",
    "custom",
    "--prompt",
    "noop",
    "--executor",
    "cloud-sandbox",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /cloud-sandbox executor is not configured/);
  assert.doesNotMatch(harness.stdout, /wrapper script/);
});
