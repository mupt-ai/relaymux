import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { collectDoctorChecks } from "../src/doctor.js";

test("doctor does not check optional message adapters by default", () => {
  const config = defaultConfig({ PATH: "" });
  const checks = collectDoctorChecks(config, { exists: false, path: "/tmp/relaymux-config.json" }, { PATH: "" });
  const names = checks.map((check) => check.name);

  assert.equal(names.includes("imessage-receive"), false);
  assert.equal(names.includes("imessage-send"), false);
  assert.equal(names.includes("telegram-token"), false);
});

test("doctor checks Telegram only when enabled without printing token contents", () => {
  const config = {
    ...defaultConfig({ PATH: "" }),
    integrations: {
      telegram: {
        enabled: true,
        chatId: "12345",
        botTokenEnv: "RELAYMUX_TEST_TELEGRAM_TOKEN",
      },
    },
  };
  const checks = collectDoctorChecks(config, { exists: false, path: "/tmp/relaymux-config.json" }, {
    PATH: "",
    RELAYMUX_TEST_TELEGRAM_TOKEN: "test-bot-token-value",
  });
  const tokenCheck = checks.find((check) => check.name === "telegram-token");
  const chatCheck = checks.find((check) => check.name === "telegram-chat-id");

  assert.equal(chatCheck?.ok, true);
  assert.equal(tokenCheck?.ok, true);
  assert.match(tokenCheck?.detail || "", /RELAYMUX_TEST_TELEGRAM_TOKEN/);
  assert.doesNotMatch(tokenCheck?.detail || "", /test-bot-token-value/);
});
