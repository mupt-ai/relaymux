import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";
import { defaultConfig, loadConfig, writeConfig, writeDefaultConfig } from "../src/config.js";

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

function tempConfigPath(name: string) {
  return path.join(os.tmpdir(), `relaymux-${process.pid}-${name}.json`);
}

function writeTempConfig(name: string) {
  const configPath = tempConfigPath(name);
  fs.rmSync(configPath, { force: true });
  writeDefaultConfig(configPath);
  return configPath;
}

function makeExecutable(dir: string, name: string, body = "printf 'fake\\n'") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test("start-tmux daemon mode is retired by default", async () => {
  const harness = makeIo();
  const code = await main(["--config", tempConfigPath("retired-start-tmux"), "start-tmux", "--session", "smoke", "--dry-run"], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /daemon mode is retired/);
  assert.match(harness.stderr, /outside tmux/);
});

test("legacy start-tmux dry-run requires explicit opt-in", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    tempConfigPath("legacy-dry-run"),
    "start-tmux",
    "--allow-tmux-daemon",
    "--session",
    "smoke",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# session: smoke/);
  assert.match(harness.stdout, /RELAYMUX_SESSION=smoke/);
  assert.match(harness.stdout, /daemon --session smoke/);
});

test("supervise-tmux daemon mode is retired by default", async () => {
  const harness = makeIo();
  const code = await main([
    "--config",
    tempConfigPath("retired-supervise-tmux"),
    "supervise-tmux",
    "--session",
    "boot-agents",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /outside tmux/);
});

test("cloud help documents the Flue scaffold without requiring config", async () => {
  const harness = makeIo();
  const code = await main(["cloud", "--help"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /relaymux cloud/);
  assert.match(harness.stdout, /cloud scaffold --flue --out <dir>/);
  assert.match(harness.stdout, /RELAYMUX_SANDBOX_TOKEN/);
});

test("cloud scaffold --flue writes a syntax-checkable bundle with env placeholders", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-cloud-scaffold-"));
  const configPath = path.join(dir, "bad-config.json");
  const outDir = path.join(dir, "bundle");
  fs.writeFileSync(configPath, "{not-json");
  const harness = makeIo();
  const code = await main(["--config", configPath, "cloud", "scaffold", "--flue", "--out", outDir], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /Created Flue cloud-agent scaffold/);

  const flue = fs.readFileSync(path.join(outDir, "flue.yml"), "utf8");
  assert.match(flue, /\$\{TELEGRAM_BOT_TOKEN\}/);
  assert.match(flue, /\$\{RELAYMUX_SANDBOX_TOKEN\}/);
  assert.match(flue, /command: npm start/);

  const bundleReadme = fs.readFileSync(path.join(outDir, "README.md"), "utf8");
  assert.match(bundleReadme, /relaymux-sandbox-hands-v1/);
  assert.match(bundleReadme, /Do not put literal tokens/);

  const check = spawnSync(process.execPath, ["--check", path.join(outDir, "src", "cloud-agent.mjs")], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test("launch dry-run defaults to the shared configured session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-shared"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--worktree-branch",
    "feature/api-fix",
    "--prompt",
    "noop",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# tmux session: agents \(shared; config\.session\)/);
  assert.doesNotMatch(harness.stdout, /# tmux session: rmx-/);
});

test("launch dry-run honors per-worktree session mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo({ RELAYMUX_SESSION: "old-shared" });
  const code = await main([
    "--config",
    writeTempConfig("launch-per-worktree"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--session-mode",
    "per-worktree",
    "--worktree-branch",
    "feature/api-fix",
    "--prompt",
    "noop",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# tmux session: rmx-/);
  assert.match(harness.stdout, /\(per-worktree;/);
  assert.doesNotMatch(harness.stdout, /# tmux session: old-shared/);
});

test("launch dry-run honors explicit session grouping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-explicit-session"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--session",
    "task-group",
    "--prompt",
    "noop",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /# tmux session: task-group \(explicit; --session\)/);
});

test("launch dry-run includes opt-in exit notification wrapper", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-repo-"));
  const harness = makeIo();
  const code = await main([
    "--config",
    writeTempConfig("launch-notify-on-exit"),
    "launch",
    "--repo",
    dir,
    "--agent",
    "custom",
    "--name",
    "api-fix",
    "--prompt",
    "noop",
    "--notify-on-exit",
    "failure",
    "--notify-reply-mode",
    "imessage",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /relaymux_should_notify=0/);
  assert.match(harness.stdout, /--reply-mode imessage/);
  assert.match(harness.stdout, /--idempotency-key "\$relaymux_idempotency_key"/);
});

test("install-launch-agent dry-run runs the daemon directly by default", async () => {
  const harness = makeIo({}, "darwin");
  const code = await main([
    "--config",
    writeTempConfig("launch-agent-direct"),
    "install-launch-agent",
    "--dry-run",
    "--no-load",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /<string>daemon<\/string>/);
  assert.match(harness.stdout, /daemon\.out\.log/);
  assert.doesNotMatch(harness.stdout, /<string>--session<\/string>/);
  assert.doesNotMatch(harness.stdout, /RELAYMUX_SESSION/);
  assert.doesNotMatch(harness.stdout, /TMUX/);
  assert.doesNotMatch(harness.stdout, /supervise-tmux/);
});

test("install-launch-agent dry-run emits a Linux systemd user service", async () => {
  const harness = makeIo({ XDG_CONFIG_HOME: path.join(os.tmpdir(), "relaymux-xdg-cli") }, "linux");
  const code = await main([
    "--config",
    writeTempConfig("launch-agent-systemd"),
    "install-launch-agent",
    "--dry-run",
    "--no-load",
  ], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /\[Unit\]/);
  assert.match(harness.stdout, /ExecStart=.*daemon/);
  assert.match(harness.stdout, /Restart=always/);
  assert.doesNotMatch(harness.stdout, /<plist/);
  assert.doesNotMatch(harness.stdout, /launchctl/);
});

test("status-launch-agent uses Linux systemd status when platform is Linux", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-status-linux-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  makeExecutable(binDir, "systemctl", `
if [ "$1" = "--user" ] && [ "$2" = "show" ]; then
  printf '%s\n' 'LoadState=loaded' 'ActiveState=active' 'SubState=running' 'MainPID=2468' 'ExecMainStatus=0' 'Result=success'
  exit 0
fi
exit 0
`);
  const configPath = writeTempConfig("status-systemd");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  try {
    const harness = makeIo({ PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(dir, "xdg") }, "linux");
    const code = await main(["--config", configPath, "status-launch-agent"], harness.io);

    assert.equal(code, 0);
    assert.match(harness.stdout, /systemd user service active/);
    assert.match(harness.stdout, /pid=2468/);
    assert.doesNotMatch(harness.stdout, /LaunchAgent/);
    assert.doesNotMatch(harness.stdout, /launchctl/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("install-launch-agent rejects tmux supervisor mode", async () => {
  const harness = makeIo({}, "darwin");
  const code = await main([
    "--config",
    writeTempConfig("launch-agent-tmux"),
    "install-launch-agent",
    "--mode",
    "tmux",
    "--dry-run",
    "--no-load",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /tmux mode has been removed/);
});

test("setup --imsg --no-launch-agent merges adapter into existing config without overwriting core settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-merge-"));
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.session = "kept-session";
  config.orchestrator.command = ["/bin/sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""];
  config.agents.local = { command: ["local-agent", "{prompt}"], promptMode: "arg" };
  writeConfig(configPath, config, { force: true });

  const harness = makeIo();
  const code = await main(["--config", configPath, "setup", "--imsg", "--chat-id", "chat-1", "--no-launch-agent"], harness.io);
  const updated = loadConfig({ configPath }).config;

  assert.equal(code, 0);
  assert.match(harness.stdout, /Updated .* with iMessage\/SMS adapter defaults/);
  assert.doesNotMatch(harness.stdout, /doctor &&/);
  assert.equal(updated.session, "kept-session");
  assert.deepEqual(updated.orchestrator.command, ["/bin/sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""]);
  assert.deepEqual(updated.agents.local.command, ["local-agent", "{prompt}"]);
  assert.equal(updated.integrations.imessage.enabled, true);
  assert.equal(updated.integrations.imessage.chatId, "chat-1");
});

test("setup --imsg --no-launch-agent is idempotent on an existing imsg config without prompting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-imsg-idempotent-"));
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.integrations.imessage = {
    enabled: true,
    chatId: "chat-1",
  };
  writeConfig(configPath, config, { force: true });

  const harness = makeIo();
  const code = await main(["--config", configPath, "setup", "--imsg", "--no-launch-agent"], harness.io);
  const updated = loadConfig({ configPath }).config;

  assert.equal(code, 0);
  assert.equal(harness.stderr, "");
  assert.equal(updated.integrations.imessage.chatId, "chat-1");
});

test("setup --imsg guidance uses separate recovery commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-guidance-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  makeExecutable(binDir, "tmux", "printf 'tmux 3.4\\n'");
  makeExecutable(binDir, "pi");
  makeExecutable(binDir, "imsg");
  const configPath = path.join(dir, "config.json");
  const harness = makeIo({ PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, RELAYMUX_HOME: path.join(dir, "home") });
  const code = await main(["--config", configPath, "setup", "--imsg", "--chat-id", "chat-1", "--no-launch-agent"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /Updated|Created/);
  assert.match(harness.stdout, /Next: relaymux restart-launch-agent/);
  assert.match(harness.stdout, /Background service installation skipped/);
  assert.doesNotMatch(harness.stdout, /doctor && relaymux restart-launch-agent && relaymux status/);
});

test("setup dry-run does not write config or mutate background services", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-dry-run-"));
  const configPath = path.join(dir, "config.json");
  const harness = makeIo();
  const code = await main(["--config", configPath, "setup", "--imsg", "--dry-run"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /Would create config/);
  assert.match(harness.stdout, /Would prompt for iMessage\/SMS chat/);
  assert.equal(fs.existsSync(configPath), false);
});

test("setup dry-run uses Linux systemd wording", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-setup-linux-dry-run-"));
  const configPath = path.join(dir, "config.json");
  const harness = makeIo({}, "linux");
  const code = await main(["--config", configPath, "setup", "--dry-run"], harness.io);

  assert.equal(code, 0);
  assert.match(harness.stdout, /Linux systemd user service/);
  assert.doesNotMatch(harness.stdout, /LaunchAgent/);
  assert.doesNotMatch(harness.stdout, /launchctl/);
  assert.equal(fs.existsSync(configPath), false);
});

test("doctor exits zero when only the macOS LaunchAgent is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-doctor-background-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  makeExecutable(binDir, "tmux", "printf 'tmux 3.4\\n'");
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.orchestrator.command = [process.execPath, "--version"];
  config.daemon.launchAgentLabel = `com.relaymux.test.${process.pid}`;
  writeConfig(configPath, config, { force: true });

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  try {
    const harness = makeIo({ PATH: process.env.PATH }, "darwin");
    const code = await main(["--config", configPath, "doctor"], harness.io);

    assert.equal(code, 0);
    assert.match(harness.stdout, /warning\tbackground-service\t/);
    assert.match(harness.stdout, /relaymux restart-launch-agent/);
    assert.match(harness.stdout, /launchctl print/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("doctor uses Linux systemd wording without launchd instructions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-doctor-linux-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  makeExecutable(binDir, "tmux", "printf 'tmux 3.4\\n'");
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig({ RELAYMUX_HOME: path.join(dir, "home") });
  config.orchestrator.command = [process.execPath, "--version"];
  config.daemon.launchAgentLabel = `com.relaymux.test.${process.pid}.linux`;
  writeConfig(configPath, config, { force: true });

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  try {
    const harness = makeIo({ PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(dir, "xdg") }, "linux");
    const code = await main(["--config", configPath, "doctor"], harness.io);

    assert.equal(code, 0);
    assert.match(harness.stdout, /background-service\t.*systemd user service/);
    assert.match(harness.stdout, /relaymux restart-launch-agent/);
    assert.doesNotMatch(harness.stdout, /launchctl/);
  } finally {
    process.env.PATH = oldPath;
  }
});
