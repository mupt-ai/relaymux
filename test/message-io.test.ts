import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import {
  buildAdapterArgv,
  commandSafeMessageText,
  filterImessageMessagesForChat,
  formatIncomingForPrompt,
  isIncomingUserMessage,
  isReceiveCommandScopedToChat,
  normalizeMessages,
  parseMessageOutput,
  receiveMessages,
  splitMessage,
} from "../src/message-io.js";


test("parseMessageOutput accepts JSON arrays and JSONL", () => {
  assert.deepEqual(parseMessageOutput('[{"id":1,"text":"hi"}]'), [{ id: 1, text: "hi" }]);
  assert.deepEqual(parseMessageOutput('{"id":1,"text":"hi"}\n{"id":2,"text":"there"}\n'), [
    { id: 1, text: "hi" },
    { id: 2, text: "there" },
  ]);
});

test("normalizeMessages maps common iMessage fields", () => {
  const [incoming, outgoing] = normalizeMessages([
    { guid: "a", text: "hello", is_from_me: false, created_at: "now" },
    { guid: "b", body: "sent", direction: "outgoing" },
  ]);

  assert.equal(incoming.id, "a");
  assert.equal(incoming.createdAt, "now");
  assert.equal(isIncomingUserMessage(incoming), true);
  assert.equal(outgoing.isFromMe, true);
  assert.equal(isIncomingUserMessage(outgoing), false);
});

test("buildAdapterArgv renders command placeholders", () => {
  assert.deepEqual(
    buildAdapterArgv({ argv: ["imsg", "send", "--chat-id", "{chatId}", "--text", "{text}"] }, { chatId: "1", text: "hello" }),
    ["imsg", "send", "--chat-id", "1", "--text", "hello"],
  );
});

test("isReceiveCommandScopedToChat requires an explicit chatId template", () => {
  assert.equal(isReceiveCommandScopedToChat({ argv: ["imsg", "history", "--chat-id", "{chatId}", "--json"] }), true);
  assert.equal(isReceiveCommandScopedToChat({ argv: ["imsg", "history", "--json"] }), false);
});

test("commandSafeMessageText protects dash-leading replies from option parsing", () => {
  assert.equal(commandSafeMessageText("hello"), "hello");
  assert.equal(commandSafeMessageText("- bullet"), "\u200B- bullet");
});

test("formatIncomingForPrompt is generic", () => {
  const text = formatIncomingForPrompt([{ id: "m1", text: "do the thing", isFromMe: false }]);
  assert.match(text, /configured iMessage\/SMS adapter chat/);
  assert.doesNotMatch(text, /Avyay|Dari/);
});

test("receiveMessages is a no-op when iMessage adapter is disabled", async () => {
  assert.deepEqual(await receiveMessages(defaultConfig({ PATH: "" })), []);
});

test("receiveMessages accepts a matching configured chat id", async () => {
  const messages = await receiveMessages(imessageReceiveConfig([
    { id: "m1", text: "from configured chat", is_from_me: false, chat_id: "chat-allowed" },
  ]));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "m1");
  assert.equal(messages[0].chatId, "chat-allowed");
});

test("receiveMessages drops mismatched explicit chat ids", async () => {
  const messages = await receiveMessages(imessageReceiveConfig([
    { id: "m1", text: "keep", is_from_me: false, conversation_id: "chat-allowed" },
    { id: "m2", text: "drop", is_from_me: false, conversation_id: "chat-other" },
  ]));

  assert.deepEqual(messages.map((message) => message.id), ["m1"]);
});

test("receiveMessages accepts untagged command output only when argv is scoped by chatId", async () => {
  const messages = await receiveMessages(imessageReceiveConfig([
    { id: "m1", text: "legacy command output", is_from_me: false },
  ]));

  assert.deepEqual(messages.map((message) => message.id), ["m1"]);
});

test("receiveMessages fails closed when receive is enabled without a configured chat id", async () => {
  await assert.rejects(
    receiveMessages(imessageReceiveConfig([{ id: "m1", text: "nope", is_from_me: false }], { chatId: "" })),
    /iMessage receive requires config\.integrations\.imessage\.chatId/,
  );
});

test("receiveMessages rejects unscoped receive commands", async () => {
  await assert.rejects(
    receiveMessages(imessageReceiveConfig([{ id: "m1", text: "nope", is_from_me: false, chat_id: "chat-allowed" }], {
      argvIncludesChatId: false,
    })),
    /iMessage receive command argv must include \{chatId\}/,
  );
});

test("filterImessageMessagesForChat drops untagged messages unless command output is scoped", () => {
  assert.deepEqual(
    filterImessageMessagesForChat([{ id: "m1", text: "hi" }], "chat-allowed", { commandScopedToChat: false }),
    [],
  );
  assert.deepEqual(
    filterImessageMessagesForChat([{ id: "m1", text: "hi" }], "chat-allowed", { commandScopedToChat: true }),
    [{ id: "m1", text: "hi" }],
  );
});

test("splitMessage chunks long text", () => {
  assert.deepEqual(splitMessage("hello", 10), ["hello"]);
  assert.ok(splitMessage("one two three four", 8).length > 1);
});

function imessageReceiveConfig(stdoutMessages, options: any = {}) {
  const stdout = JSON.stringify(stdoutMessages);
  const config: any = defaultConfig({ PATH: "" });
  const argv = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(stdout)})`];
  if (options.argvIncludesChatId !== false) argv.push("{chatId}");
  config.integrations.imessage = {
    enabled: true,
    chatId: options.chatId ?? "chat-allowed",
    receive: {
      backend: "command",
      command: {
        argv,
        cwd: "~",
        timeoutMs: 5000,
      },
    },
  };
  return config;
}
