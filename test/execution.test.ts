import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, writeConfig } from "../src/config.js";
import { main } from "../src/cli.js";
import { resolveAgentConfig } from "../src/execution/agents.js";
import { resolveExecutorName } from "../src/execution/selection.js";

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

test("agent names resolve exactly from config", () => {
  const config = defaultConfig();

  const resolved = resolveAgentConfig(config, "claude");

  assert.equal(resolved.agentName, "claude");
  assert.equal(resolved.requestedAgent, "claude");
  assert.deepEqual(resolved.agentConfig.command, config.agents.claude.command);
  assert.throws(() => resolveAgentConfig(config, "cc"), /Unknown agent "cc"/);
});

test("launch executor selection is tmux-only", () => {
  assert.equal(resolveExecutorName({ flags: {} }), "local-tmux");
  assert.equal(resolveExecutorName({ flags: { executor: "local-tmux" } }), "local-tmux");
  assert.throws(() => resolveExecutorName({ flags: { executor: "other" } }), /agents only in tmux tabs/);
});

test("launch rejects --mode for executor selection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-mode-"));
  const configPath = path.join(root, "config.json");
  writeConfig(configPath, {
    ...defaultConfig({ RELAYMUX_HOME: path.join(root, "home") }),
    stateDir: path.join(root, "state"),
  });
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
    "--mode",
    "other",
    "--dry-run",
  ], harness.io);

  assert.equal(code, 1);
  assert.match(harness.stderr, /--mode is not supported/);
});
