import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildTelegramConfig, discoverTelegramChatId, resolveTelegramTokenFile } from "../src/setup-telegram.js";

test("resolveTelegramTokenFile stores a passed bot token privately", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymux-telegram-token-"));
  const tokenFile = path.join(dir, "token");
  const io = { stdout: { write() {} }, stdin: {}, env: { HOME: dir } };

  const resolved = await resolveTelegramTokenFile({ telegramBotToken: "bot-token", telegramStoreTokenFile: tokenFile }, io, io.env);

  assert.equal(resolved, tokenFile);
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "bot-token\n");
  assert.equal((fs.statSync(tokenFile).mode & 0o777), 0o600);
});

test("discoverTelegramChatId reads the first human chat from getUpdates", async () => {
  const server = http.createServer((req, res) => {
    assert.match(req.url || "", /\/bottest-token\/getUpdates/);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      result: [
        { update_id: 1, message: { message_id: 1, from: { is_bot: true }, chat: { id: "skip" }, text: "bot" } },
        { update_id: 2, message: { message_id: 2, from: { is_bot: false }, chat: { id: 12345 }, text: "/start" } },
      ],
    }));
  });
  await listen(server);
  const address: any = server.address();

  try {
    const chatId = await discoverTelegramChatId({ token: "test-token", apiBaseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });
    assert.equal(chatId, "12345");
  } finally {
    await close(server);
  }
});

test("buildTelegramConfig uses a placeholder orchestrator when no agent CLI is installed", () => {
  const config = buildTelegramConfig({ telegramChatId: "123", telegramBotTokenFile: "/tmp/token" }, { PATH: "" });

  assert.equal(config.orchestrator.command[0], "/bin/sh");
  assert.ok(config.orchestrator.description.includes("Placeholder orchestrator"));
  assert.ok(config.agents.custom);
});

function listen(server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
