import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";

function makeIo(env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const baseEnv = { ...process.env };
  delete baseEnv.RELAYMUX_HOME;
  return {
    io: {
      env: { ...baseEnv, ...env },
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function tempRoot(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relaymux-workflow-${name}-`));
}

function writeWorkflow(dir: string, name: string, source: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

test("workflow run/list/status loads TypeScript and records shell artifacts", async () => {
  const root = tempRoot("success");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "success.ts", `
import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow<{ message: string }>({
  async run(ctx, input) {
    ctx.emit("custom_event", { message: input.message });
    const result = await ctx.step("echo", shell({
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", input.message],
      timeoutMs: 5000,
    }));
    const notePath = ctx.artifact("note.txt", "done");
    return { ok: result.ok, stdout: result.data.stdoutSnippet, notePath };
  },
});
`);
  const runHarness = makeIo({ RELAYMUX_HOME: home });

  const code = await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "success",
    "--input-json",
    JSON.stringify({ message: "hello workflow" }),
    "--json",
  ], runHarness.io);

  assert.equal(code, 0, runHarness.stderr);
  const outcome = JSON.parse(runHarness.stdout);
  assert.equal(outcome.reused, false);
  assert.equal(outcome.run.status, "succeeded");
  assert.match(outcome.run.workflowRunId, /^wf-/);
  assert.equal(outcome.result.stdout, "hello workflow");
  assert.equal(JSON.parse(fs.readFileSync(outcome.run.resultPath, "utf8")).stdout, "hello workflow");

  const listHarness = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "list", "--json"], listHarness.io), 0);
  const listed = JSON.parse(listHarness.stdout);
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].workflowRunId, outcome.run.workflowRunId);

  const statusHarness = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "status", outcome.run.workflowRunId, "--events", "--json"], statusHarness.io), 0);
  const status = JSON.parse(statusHarness.stdout);
  const eventNames = status.events.map((event) => event.event);
  assert.ok(eventNames.includes("workflow_started"));
  assert.ok(eventNames.includes("step_started"));
  assert.ok(eventNames.includes("step_completed"));
  assert.ok(eventNames.includes("artifact"));
  assert.ok(eventNames.includes("workflow_completed"));

  const stdoutArtifact = status.events.find((event) => event.artifact?.name === "stdout");
  assert.match(fs.readFileSync(stdoutArtifact.artifact.path, "utf8"), /hello workflow/);
});

test("workflow shell step failure marks the run failed and captures stderr", async () => {
  const root = tempRoot("failure");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "failure.ts", `
import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow({
  async run(ctx) {
    await ctx.step("explode", shell({
      argv: [process.execPath, "-e", "process.stderr.write('boom'); process.exit(7)"],
    }));
  },
});
`);
  const runHarness = makeIo({ RELAYMUX_HOME: home });

  const code = await main(["workflow", "run", workflowFile, "--name", "failure", "--json"], runHarness.io);

  assert.equal(code, 1);
  const outcome = JSON.parse(runHarness.stdout);
  assert.equal(outcome.run.status, "failed");
  assert.match(outcome.error.message, /Workflow step "explode" failed/);

  const statusHarness = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "status", outcome.run.workflowRunId, "--events", "--json"], statusHarness.io), 0);
  const status = JSON.parse(statusHarness.stdout);
  const failedEvent = status.events.find((event) => event.event === "step_failed");
  assert.equal(failedEvent.stepId, "explode");
  assert.equal(failedEvent.result.exitCode, 7);
  const stderrArtifact = status.events.find((event) => event.artifact?.name === "stderr");
  assert.match(fs.readFileSync(stderrArtifact.artifact.path, "utf8"), /boom/);
});

test("workflow idempotency key reuses an existing run", async () => {
  const root = tempRoot("idempotency");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "idempotency.ts", `
import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow({
  async run(ctx) {
    const result = await ctx.step("once", shell({
      argv: [process.execPath, "-e", "process.stdout.write('ran-once')"],
    }));
    return { stdout: result.data.stdoutSnippet };
  },
});
`);

  const first = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent",
    "--idempotency-key",
    "stable-key",
    "--json",
  ], first.io), 0);
  const firstOutcome = JSON.parse(first.stdout);

  const second = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent",
    "--idempotency-key",
    "stable-key",
    "--json",
  ], second.io), 0);
  const secondOutcome = JSON.parse(second.stdout);

  assert.equal(secondOutcome.reused, true);
  assert.equal(secondOutcome.run.workflowRunId, firstOutcome.run.workflowRunId);

  const listHarness = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "list", "--json"], listHarness.io), 0);
  assert.equal(JSON.parse(listHarness.stdout).runs.length, 1);
});

test("workflow shell redacts sensitive env and argv in persisted status", async () => {
  const root = tempRoot("redaction");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "redaction.ts", `
import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow({
  async run(ctx) {
    const result = await ctx.step("secret-env", shell({
      argv: [process.execPath, "-e", "process.stdout.write(process.env.SECRET_TOKEN ? 'secret-present' : 'missing')"],
      env: { SECRET_TOKEN: "super-secret-value" },
    }));
    return { stdout: result.data.stdoutSnippet, argv: result.data.argv };
  },
});
`);
  const runHarness = makeIo({ RELAYMUX_HOME: home });

  const code = await main(["workflow", "run", workflowFile, "--name", "redaction", "--json"], runHarness.io);

  assert.equal(code, 0, runHarness.stderr);
  const outcome = JSON.parse(runHarness.stdout);
  assert.equal(outcome.result.stdout, "secret-present");
  assert.doesNotMatch(JSON.stringify(outcome), /super-secret-value/);
  assert.deepEqual(outcome.result.argv, [process.execPath, "-e", "<redacted>"]);

  const statusHarness = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "status", outcome.run.workflowRunId, "--events", "--json"], statusHarness.io), 0);
  const status = JSON.parse(statusHarness.stdout);
  assert.doesNotMatch(JSON.stringify(status), /super-secret-value/);
  const started = status.events.find((event) => event.event === "step_started");
  assert.deepEqual(started.description.argv, [process.execPath, "-e", "<redacted>"]);
  assert.equal(started.description.env.SECRET_TOKEN, "<redacted>");
});
