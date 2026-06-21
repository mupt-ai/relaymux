import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, defaultConfigPath, legacyDefaultConfigPath, loadConfig, writeDefaultConfig } from "../src/config.js";

test("writeDefaultConfig creates a loadable config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-"));
  const configPath = path.join(dir, "config.json");

  writeDefaultConfig(configPath);
  const { config, exists } = loadConfig({ configPath });

  assert.equal(exists, true);
  assert.equal(config.session, "agents");
  assert.equal(config.integrations.imessage, undefined);
  assert.equal(config.launchNotifications.replyMode, "none");
  assert.equal(config.daemon.host, "127.0.0.1");
  assert.equal(config.daemon.launchMode, "direct");
  assert.equal(config.tmux.sessionMode, "shared");
  assert.ok(config.orchestrator.command);
  assert.equal(config.orchestrator.defaultSystemPrompt, true);
  assert.equal(config.orchestrator.systemPromptFile, "");
  assert.equal(config.orchestrator.personalityPromptFile, "");
  assert.equal(config.orchestrator.extraSystemPrompt, "");
  assert.ok(config.agents.codex);
  assert.equal(config.agents.codex.command.includes("--reasoning-effort"), false);
  assert.equal(config.launchNotifications.onExit, "never");
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /You are a local relaymux orchestrator/);
  assert.doesNotMatch(written, /SOUL\.md/);
});

test("loadConfig treats legacy top-level imessage as enabled integration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-imsg-alias-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    imessage: {
      chatId: "chat-1",
      send: { command: { argv: ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}"] } },
    },
  }));

  const { config } = loadConfig({ configPath });

  assert.equal(config.integrations.imessage.enabled, true);
  assert.equal(config.integrations.imessage.chatId, "chat-1");
  assert.ok(config.integrations.imessage.receive.command.argv.includes("{chatId}"));
  assert.equal(config.launchNotifications.replyMode, "imessage");
});

test("default paths live under RELAYMUX_HOME when provided", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-home-"));
  const home = path.join(dir, "home");
  const env = { RELAYMUX_HOME: home, XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const config = defaultConfig(env);

  assert.equal(defaultConfigPath(env), path.join(home, "config.json"));
  assert.equal(legacyDefaultConfigPath(env), path.join(dir, "xdg", "relaymux", "config.json"));
  assert.equal(config.stateDir, path.join(home, "state"));
  assert.equal(config.daemon.tokenFile, path.join(home, "state", "webhook-token"));
  assert.equal(config.daemon.logDir, path.join(home, "logs"));
});

test("loadConfig falls back to the legacy default config path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-legacy-"));
  const env = { RELAYMUX_HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const legacyPath = legacyDefaultConfigPath(env);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    session: "legacy",
    stateDir: "~/.local/state/relaymux",
  }));

  const info = loadConfig({ env });

  assert.equal(info.exists, true);
  assert.equal(info.path, legacyPath);
  assert.equal(info.usingLegacyDefault, true);
  assert.equal(info.config.session, "legacy");
  assert.equal(info.config.daemon.tokenFile, "~/.local/state/relaymux/webhook-token");
  assert.equal(info.config.daemon.logDir, "~/.local/state/relaymux/logs");
});

test("loadConfig does not fall back when an explicit config path is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-explicit-"));
  const env = { RELAYMUX_HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const legacyPath = legacyDefaultConfigPath(env);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({ session: "legacy" }));

  const explicit = path.join(dir, "missing.json");
  const info = loadConfig({ configPath: explicit, env });

  assert.equal(info.exists, false);
  assert.equal(info.path, explicit);
});

test("loadConfig merges user agents with defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    session: "review",
    agents: {
      local: {
        command: ["local-agent"],
        promptMode: "stdin",
      },
    },
  }));

  const { config } = loadConfig({ configPath });
  assert.equal(config.session, "review");
  assert.ok(config.agents.codex);
  assert.deepEqual(config.agents.local.command, ["local-agent"]);
});
