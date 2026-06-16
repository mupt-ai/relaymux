import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { buildIncomingOrchestratorPrompt, buildTerminalOrchestratorPrompt } from "../src/orchestrator.js";

function terminalJob(overrides: Record<string, any> = {}) {
  return {
    source: "cli",
    requestId: "req-1",
    receivedAt: "2026-06-16T00:00:00.000Z",
    replyMode: "none",
    metadata: {},
    text: "inspect the failing tests",
    ...overrides,
  };
}

test("orchestrator requests include repo-managed best practices by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-orchestrator-default-"));
  const config = defaultConfig({ RELAYMUX_HOME: path.join(dir, "home") });
  const prompt = buildTerminalOrchestratorPrompt({
    config,
    configPath: path.join(dir, "config.json"),
    job: terminalJob(),
  });

  assert.match(prompt, /You are a local relaymux orchestrator/);
  assert.match(prompt, /Delegate by default when the work may take more than about 2 minutes/);
  assert.match(prompt, /repo code changes, PR fixes, deploy\/debugging work, deep research, CI loops, docs rewrites, long validation, and multi-file edits/);
  assert.match(prompt, /Do quick routing, lightweight read-only inspection, tiny personal-file edits, and quick answers inline/);
  assert.match(prompt, /Do not add --session or --session-mode/);
  assert.match(prompt, /inspect relaymux status and the tmux window\/pane output before claiming that it started/);
  assert.match(prompt, /belongs to an existing active subagent\/tab, send the instruction to that tab instead of launching a duplicate run/);
  assert.match(prompt, /Do not use one-shot model print-mode or non-interactive shortcuts as a substitute/);
  assert.match(prompt, /Include an idempotency key/);
  assert.match(prompt, /prefer an isolated branch or worktree/);
  assert.match(prompt, /# Terminal request/);
});

test("orchestrator prompt file and extra prompt remain additive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-orchestrator-custom-"));
  const customPromptFile = path.join(dir, "custom-system-prompt.md");
  fs.writeFileSync(customPromptFile, "Local custom system prompt.");
  const config = defaultConfig({ RELAYMUX_HOME: path.join(dir, "home") });
  config.orchestrator.systemPromptFile = customPromptFile;
  config.orchestrator.extraSystemPrompt = "Extra local prompt.";

  const prompt = buildIncomingOrchestratorPrompt({
    config,
    configPath: path.join(dir, "config.json"),
    incomingText: "hello",
  });

  assert.match(prompt, /You are a local relaymux orchestrator/);
  assert.match(prompt, /Local custom system prompt/);
  assert.match(prompt, /Extra local prompt/);
  assert.ok(prompt.indexOf("You are a local relaymux orchestrator") < prompt.indexOf("Local custom system prompt"));
  assert.ok(prompt.indexOf("Local custom system prompt") < prompt.indexOf("Extra local prompt"));
});

test("orchestrator default system prompt can be disabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-orchestrator-disable-"));
  const config = defaultConfig({ RELAYMUX_HOME: path.join(dir, "home") });
  config.orchestrator.defaultSystemPrompt = false;
  config.orchestrator.extraSystemPrompt = "Only this local prompt.";

  const prompt = buildTerminalOrchestratorPrompt({
    config,
    configPath: path.join(dir, "config.json"),
    job: terminalJob(),
  });

  assert.doesNotMatch(prompt, /You are a local relaymux orchestrator/);
  assert.match(prompt, /Only this local prompt/);
  assert.match(prompt, /Runtime context:/);
  assert.match(prompt, /# Terminal request/);
});
