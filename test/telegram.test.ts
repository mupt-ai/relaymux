import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { sendTelegramMessage } from "../src/telegram.js";

test("sendTelegramMessage posts to Telegram Bot API shape", async () => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await listen(server);
  const address: any = server.address();

  try {
    await sendTelegramMessage({
      integrations: {
        telegram: {
          enabled: true,
          chatId: "chat-123",
          botTokenEnv: "RELAYMUX_TEST_TELEGRAM_TOKEN",
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 1000,
        },
      },
    }, "hello", { env: { RELAYMUX_TEST_TELEGRAM_TOKEN: "test-bot-token" } });
  } finally {
    await close(server);
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/bottest-bot-token/sendMessage");
  assert.deepEqual(requests[0].body, { chat_id: "chat-123", text: "hello" });
});

test("sendTelegramMessage reports missing token without token contents", async () => {
  await assert.rejects(
    sendTelegramMessage({
      integrations: {
        telegram: {
          enabled: true,
          chatId: "chat-123",
          botTokenEnv: "RELAYMUX_TEST_TELEGRAM_TOKEN",
        },
      },
    }, "hello", { env: {} }),
    /RELAYMUX_TEST_TELEGRAM_TOKEN/,
  );
});

function listen(server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
