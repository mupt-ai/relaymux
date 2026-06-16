import assert from "node:assert/strict";
import test from "node:test";

import {
  RELAYMUX_SANDBOX_HANDS_PROTOCOL,
  buildSandboxAskRequest,
  buildSandboxLaunchRequest,
  buildSandboxNotifyRequest,
  normalizeSandboxEnvelope,
} from "../src/cloud-protocol.js";

test("buildSandboxAskRequest defaults to quiet sandbox execution", () => {
  const request = buildSandboxAskRequest({
    text: "inspect the failing tests",
    source: "telegram",
    idempotencyKey: "telegram:1:2",
    metadata: { telegram: { chatId: "1" } },
  });

  assert.equal(request.protocol, RELAYMUX_SANDBOX_HANDS_PROTOCOL);
  assert.equal(request.operation, "ask");
  assert.equal(request.replyMode, "none");
  assert.equal(request.wait, true);
  assert.equal(request.idempotencyKey, "telegram:1:2");
  assert.deepEqual(request.metadata, { telegram: { chatId: "1" } });
});

test("buildSandboxLaunchRequest captures direct launch requests", () => {
  const request = buildSandboxLaunchRequest({
    repo: "~/code/app",
    agent: "pi",
    name: "fix-tests",
    prompt: "fix the tests",
    notify: {
      callback: { url: "https://cloud.example.test/relaymux/v1/completion" },
      idempotencyKey: "launch-1",
    },
  });

  assert.equal(request.operation, "launch");
  assert.equal(request.repo, "~/code/app");
  assert.equal(request.agent, "pi");
  assert.equal(request.notify.callback.authTokenEnv, "RELAYMUX_CLOUD_CALLBACK_TOKEN");
});

test("buildSandboxNotifyRequest captures completion callbacks", () => {
  const request = buildSandboxNotifyRequest({
    from: "fix-tests",
    text: "done",
    idempotencyKey: "done-1",
  });

  assert.equal(request.operation, "notify");
  assert.equal(request.from, "fix-tests");
  assert.equal(request.text, "done");
});

test("normalizeSandboxEnvelope rejects wrong protocol and operations", () => {
  assert.throws(
    () => normalizeSandboxEnvelope({ protocol: "other", operation: "ask" }),
    /relaymux-sandbox-hands-v1/,
  );
  assert.throws(
    () => normalizeSandboxEnvelope({ protocol: RELAYMUX_SANDBOX_HANDS_PROTOCOL, operation: "shell" }),
    /operation/,
  );
  assert.equal(
    normalizeSandboxEnvelope({ protocol: RELAYMUX_SANDBOX_HANDS_PROTOCOL, operation: "ask" }, "ask").operation,
    "ask",
  );
});

