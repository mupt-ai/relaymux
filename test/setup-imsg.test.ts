import assert from "node:assert/strict";
import test from "node:test";

import { buildImsgConfig, formatChat } from "../src/setup-imsg.js";


test("buildImsgConfig creates usable imsg defaults", () => {
  const config = buildImsgConfig({
    chatId: "chat-1",
    cwd: "/tmp/project",
    stateDir: "~/.state/relaymux-test",
    imsgPath: "/usr/local/bin/imsg",
    piPath: "/usr/local/bin/pi",
    session: "work",
    port: 49999,
  }, { PATH: "" });

  assert.equal(config.session, "work");
  assert.equal(config.integrations.imessage.enabled, true);
  assert.equal(config.integrations.imessage.chatId, "chat-1");
  assert.deepEqual(config.integrations.imessage.receive.command.argv.slice(0, 4), [
    "/usr/local/bin/imsg",
    "history",
    "--chat-id",
    "{chatId}",
  ]);
  assert.deepEqual(config.integrations.imessage.send.command.argv.slice(0, 6), [
    "/usr/local/bin/imsg",
    "send",
    "--chat-id",
    "{chatId}",
    "--text",
    "{text}",
  ]);
  assert.deepEqual(config.orchestrator.command, [
    "/usr/local/bin/pi",
    "--print",
    "--continue",
    "--session-dir",
    "~/.state/relaymux-test/sessions",
    "{prompt}",
  ]);
  assert.equal(config.daemon.tokenFile, "~/.state/relaymux-test/webhook-token");
  assert.equal(config.daemon.port, 49999);
  assert.deepEqual(config.agents.pi.command, ["/usr/local/bin/pi", "{prompt}"]);
  assert.ok(config.agents.custom);
});

test("formatChat shows id and label", () => {
  assert.equal(formatChat({ id: "1", label: "Example" }), "1\tExample");
  assert.equal(formatChat({ id: "2", label: "" }), "2");
});
