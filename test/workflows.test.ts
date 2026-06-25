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
  assert.equal(fs.existsSync(path.join(home, "state", "workflows", "runs.jsonl")), false);

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

test("workflow status rejects traversal outside the workflows directory", async () => {
  const root = tempRoot("traversal");
  const home = path.join(root, "home");
  const stateDir = path.join(home, "state");
  const outsideDir = path.join(stateDir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "run.json"), JSON.stringify({
    workflowRunId: "outside",
    name: "outside",
    status: "succeeded",
  }));

  for (const badRunId of ["../outside", "..\\\\outside", "/tmp/wf-any-12345678", ".", "wf-../12345678"]) {
    const harness = makeIo({ RELAYMUX_HOME: home });
    const code = await main(["workflow", "status", badRunId, "--json"], harness.io);
    assert.equal(code, 1, badRunId);
    assert.match(harness.stderr, /Invalid workflow run id/);
    assert.equal(harness.stdout, "");
  }
});

test("workflow shell timeout kills grandchildren and marks the workflow timed_out", { timeout: 5000 }, async () => {
  if (process.platform === "win32") {
    return;
  }

  const root = tempRoot("timeout-tree");
  const home = path.join(root, "home");
  const command = `${JSON.stringify(process.execPath)} -e 'setInterval(() => process.stdout.write("tick\\\\n"), 50)' & wait`;
  const workflowFile = writeWorkflow(root, "timeout-tree.ts", `
import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow({
  async run(ctx) {
    await ctx.step("hang-with-grandchild", shell({
      argv: ["sh", "-c", ${JSON.stringify(command)}],
      timeoutMs: 150,
    }));
  },
});
`);
  const runHarness = makeIo({ RELAYMUX_HOME: home });
  const started = Date.now();

  const code = await main(["workflow", "run", workflowFile, "--name", "timeout-tree", "--json"], runHarness.io);

  assert.equal(code, 1, runHarness.stderr);
  assert.ok(Date.now() - started < 3000);
  const outcome = JSON.parse(runHarness.stdout);
  assert.equal(outcome.run.status, "timed_out");

  const statusHarness = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "status", outcome.run.workflowRunId, "--events", "--json"], statusHarness.io), 0);
  const status = JSON.parse(statusHarness.stdout);
  assert.ok(status.events.some((event) => event.event === "workflow_timed_out"));
  assert.ok(status.events.some((event) => event.event === "step_failed" && event.status === "timed_out"));
});

test("workflow idempotency key rejects changed input", async () => {
  const root = tempRoot("idempotency-input");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "idempotency-input.ts", `
import { defineWorkflow } from "@relaymux/workflows";

export default defineWorkflow<{ message: string }>({
  async run(_ctx, input) {
    return { message: input.message };
  },
});
`);

  const first = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-input",
    "--idempotency-key",
    "same-key",
    "--input-json",
    JSON.stringify({ message: "first" }),
    "--json",
  ], first.io), 0, first.stderr);

  const second = makeIo({ RELAYMUX_HOME: home });
  const secondCode = await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-input",
    "--idempotency-key",
    "same-key",
    "--input-json",
    JSON.stringify({ message: "second" }),
    "--json",
  ], second.io);

  assert.equal(secondCode, 1);
  assert.match(second.stderr, /Idempotency conflict/);
  assert.equal(second.stdout, "");
});

test("workflow idempotency key rejects changed definition", async () => {
  const root = tempRoot("idempotency-definition");
  const home = path.join(root, "home");
  const workflowFile = path.join(root, "idempotency-definition.ts");
  fs.writeFileSync(workflowFile, `
import { defineWorkflow } from "@relaymux/workflows";

export default defineWorkflow({
  async run() {
    return { version: 1 };
  },
});
`);

  const first = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-definition",
    "--idempotency-key",
    "same-key",
    "--json",
  ], first.io), 0, first.stderr);

  fs.writeFileSync(workflowFile, `
import { defineWorkflow } from "@relaymux/workflows";

export default defineWorkflow({
  async run() {
    return { version: 2 };
  },
});
`);

  const second = makeIo({ RELAYMUX_HOME: home });
  const secondCode = await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-definition",
    "--idempotency-key",
    "same-key",
    "--json",
  ], second.io);

  assert.equal(secondCode, 1);
  assert.match(second.stderr, /Idempotency conflict/);
  assert.equal(second.stdout, "");
});

test("workflow idempotency key retries after a failed terminal run", async () => {
  const root = tempRoot("idempotency-retry");
  const home = path.join(root, "home");
  const markerPath = path.join(root, "retry-marker");
  const workflowFile = writeWorkflow(root, "idempotency-retry.ts", `
import fs from "node:fs";
import { defineWorkflow, shell } from "@relaymux/workflows";

const markerPath = ${JSON.stringify(markerPath)};

export default defineWorkflow({
  async run(ctx) {
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, "failed-once");
      await ctx.step("fail-once", shell({
        argv: [process.execPath, "-e", "process.exit(7)"],
      }));
    }
    return { retried: true };
  },
});
`);

  const first = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-retry",
    "--idempotency-key",
    "retry-key",
    "--json",
  ], first.io), 1);
  const firstOutcome = JSON.parse(first.stdout);
  assert.equal(firstOutcome.run.status, "failed");

  const second = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-retry",
    "--idempotency-key",
    "retry-key",
    "--json",
  ], second.io), 0, second.stderr);
  const secondOutcome = JSON.parse(second.stdout);
  assert.equal(secondOutcome.reused, false);
  assert.equal(secondOutcome.run.status, "succeeded");
  assert.notEqual(secondOutcome.run.workflowRunId, firstOutcome.run.workflowRunId);
});

test("workflow idempotency reservation prevents concurrent duplicate execution", async () => {
  const root = tempRoot("idempotency-concurrent");
  const home = path.join(root, "home");
  const counterPath = path.join(root, "counter.txt");
  const workflowFile = writeWorkflow(root, "idempotency-concurrent.ts", `
import fs from "node:fs";
import { defineWorkflow } from "@relaymux/workflows";

const counterPath = ${JSON.stringify(counterPath)};

export default defineWorkflow({
  async run() {
    const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
    fs.writeFileSync(counterPath, String(current + 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { count: current + 1 };
  },
});
`);
  const args = [
    "workflow",
    "run",
    workflowFile,
    "--name",
    "idempotent-concurrent",
    "--idempotency-key",
    "concurrent-key",
    "--json",
  ];
  const first = makeIo({ RELAYMUX_HOME: home });
  const second = makeIo({ RELAYMUX_HOME: home });

  const [firstCode, secondCode] = await Promise.all([
    main(args, first.io),
    main(args, second.io),
  ]);

  assert.equal(firstCode, 0, first.stderr);
  assert.equal(secondCode, 0, second.stderr);
  const outcomes = [JSON.parse(first.stdout), JSON.parse(second.stdout)];
  const executed = outcomes.filter((outcome) => outcome.reused === false);
  const reused = outcomes.filter((outcome) => outcome.reused === true);
  assert.equal(executed.length, 1);
  assert.equal(reused.length, 1);
  assert.equal(reused[0].run.workflowRunId, executed[0].run.workflowRunId);
  assert.equal(fs.readFileSync(counterPath, "utf8"), "1");
});

test("workflow duplicate step ids fail clearly instead of replaying cached output", async () => {
  const root = tempRoot("duplicate-step");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "duplicate-step.ts", `
import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow({
  async run(ctx) {
    await ctx.step("same-step", shell({
      argv: [process.execPath, "-e", "process.stdout.write('first')"],
    }));
    await ctx.step("same-step", shell({
      argv: [process.execPath, "-e", "process.stdout.write('second')"],
    }));
  },
});
`);
  const runHarness = makeIo({ RELAYMUX_HOME: home });

  const code = await main(["workflow", "run", workflowFile, "--name", "duplicate-step", "--json"], runHarness.io);

  assert.equal(code, 1);
  const outcome = JSON.parse(runHarness.stdout);
  assert.equal(outcome.run.status, "failed");
  assert.match(outcome.error.message, /Duplicate workflow step id "same-step"/);
});

test("workflow run reads --input-file", async () => {
  const root = tempRoot("input-file");
  const home = path.join(root, "home");
  const inputFile = path.join(root, "input.json");
  fs.writeFileSync(inputFile, JSON.stringify({ message: "from file" }));
  const workflowFile = writeWorkflow(root, "input-file.ts", `
import { defineWorkflow } from "@relaymux/workflows";

export default defineWorkflow<{ message: string }>({
  async run(_ctx, input) {
    return { message: input.message };
  },
});
`);
  const runHarness = makeIo({ RELAYMUX_HOME: home });

  const code = await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "input-file",
    "--input-file",
    inputFile,
    "--json",
  ], runHarness.io);

  assert.equal(code, 0, runHarness.stderr);
  assert.equal(JSON.parse(runHarness.stdout).result.message, "from file");
});

test("workflow CLI rejects invalid input and missing status arguments", async () => {
  const root = tempRoot("cli-errors");
  const home = path.join(root, "home");
  const workflowFile = writeWorkflow(root, "cli-errors.ts", `
import { defineWorkflow } from "@relaymux/workflows";
export default defineWorkflow({ async run() { return { ok: true }; } });
`);

  const invalidJson = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "bad-json",
    "--input-json",
    "{",
  ], invalidJson.io), 1);
  assert.match(invalidJson.stderr, /Invalid --input-json/);

  const mutuallyExclusive = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main([
    "workflow",
    "run",
    workflowFile,
    "--name",
    "exclusive",
    "--input-json",
    "{}",
    "--input-file",
    workflowFile,
  ], mutuallyExclusive.io), 1);
  assert.match(mutuallyExclusive.stderr, /Use either --input-json or --input-file/);

  const missingFile = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "run"], missingFile.io), 1);
  assert.match(missingFile.stderr, /Missing workflow file/);

  const missingName = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "run", workflowFile], missingName.io), 1);
  assert.match(missingName.stderr, /Missing --name/);

  const unknownRun = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "status", "wf-missing-12345678"], unknownRun.io), 1);
  assert.match(unknownRun.stderr, /Unknown workflow run "wf-missing-12345678"/);

  const eventsWithoutId = makeIo({ RELAYMUX_HOME: home });
  assert.equal(await main(["workflow", "status", "--events"], eventsWithoutId.io), 1);
  assert.match(eventsWithoutId.stderr, /workflow status --events requires a workflowRunId/);
});
