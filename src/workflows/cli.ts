import fs from "node:fs";
import path from "node:path";

import { expandPath } from "../paths.js";

import { runWorkflow } from "./runner.js";
import { listWorkflowRuns, readWorkflowEvents, readWorkflowRun } from "./state.js";

export async function handleWorkflowCommand({ flags, positionals, stateDir, io }: any) {
  const subcommand = positionals[0] || "help";
  const rest = positionals.slice(1);

  if (flags.help || subcommand === "help") {
    io.stdout.write(workflowHelpText());
    return 0;
  }

  if (subcommand === "run") {
    return handleWorkflowRun({ flags, positionals: rest, stateDir, io });
  }
  if (subcommand === "status") {
    return handleWorkflowStatus({ flags, positionals: rest, stateDir, io });
  }
  if (subcommand === "list") {
    return handleWorkflowList({ flags, stateDir, io });
  }

  throw new Error(`Unknown workflow command "${subcommand}". Use run, status, or list.`);
}

async function handleWorkflowRun({ flags, positionals, stateDir, io }: any) {
  const file = positionals[0];
  if (!file) {
    throw new Error("Missing workflow file. Usage: relaymux workflow run <file> --name <name>");
  }
  if (!flags.name) {
    throw new Error("Missing --name <name>");
  }

  const input = readWorkflowInput(flags);
  const outcome = await runWorkflow({
    file,
    name: flags.name,
    input,
    idempotencyKey: flags.idempotencyKey || "",
    stateDir,
  });

  if (flags.json) {
    io.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else if (outcome.reused) {
    io.stdout.write(`Workflow run ${outcome.run.workflowRunId} already exists for idempotency key ${flags.idempotencyKey}\n`);
    io.stdout.write(`Status: ${outcome.run.status}\n`);
  } else {
    io.stdout.write(`Workflow Run ID: ${outcome.run.workflowRunId}\n`);
    io.stdout.write(`Status: ${outcome.run.status}\n`);
    io.stdout.write(`State: ${outcome.run.runDir}\n`);
    if (outcome.run.resultPath) {
      io.stdout.write(`Result: ${outcome.run.resultPath}\n`);
    }
    if (outcome.error) {
      io.stdout.write(`Error: ${outcome.error.message}\n`);
    }
  }

  return ["failed", "timed_out", "canceled"].includes(outcome.run.status) ? 1 : 0;
}

function handleWorkflowStatus({ flags, positionals, stateDir, io }: any) {
  const workflowRunId = positionals[0];
  if (flags.events && !workflowRunId) {
    throw new Error("workflow status --events requires a workflowRunId");
  }

  if (workflowRunId) {
    const run = readWorkflowRun(stateDir, workflowRunId);
    if (!run) {
      throw new Error(`Unknown workflow run "${workflowRunId}"`);
    }
    const events = flags.events ? readWorkflowEvents(stateDir, workflowRunId) : undefined;
    if (flags.json) {
      io.stdout.write(`${JSON.stringify({ run, events }, null, 2)}\n`);
      return 0;
    }

    io.stdout.write(formatWorkflowRun(run));
    if (events) {
      io.stdout.write(formatWorkflowEvents(events));
    }
    return 0;
  }

  const runs = listWorkflowRuns(stateDir);
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ runs }, null, 2)}\n`);
    return 0;
  }
  if (runs.length === 0) {
    io.stdout.write("No workflow runs found.\n");
    return 0;
  }
  io.stdout.write(formatWorkflowTable(runs));
  return 0;
}

function handleWorkflowList({ flags, stateDir, io }: any) {
  const runs = listWorkflowRuns(stateDir);
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ runs }, null, 2)}\n`);
    return 0;
  }
  if (runs.length === 0) {
    io.stdout.write("No workflow runs found.\n");
    return 0;
  }
  io.stdout.write(formatWorkflowTable(runs));
  return 0;
}

function readWorkflowInput(flags) {
  if (flags.inputJson && flags.inputFile) {
    throw new Error("Use either --input-json or --input-file, not both");
  }
  if (flags.inputJson !== undefined) {
    return parseInputJson(String(flags.inputJson), "--input-json");
  }
  if (flags.inputFile) {
    const file = expandPath(String(flags.inputFile));
    return parseInputJson(fs.readFileSync(file, "utf8"), `--input-file ${file}`);
  }
  return {};
}

function parseInputJson(raw, source) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${source}: ${error.message}`);
  }
}

function formatWorkflowRun(run) {
  return [
    `Workflow Run ID: ${run.workflowRunId}`,
    `Name: ${run.name}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    `Completed: ${run.endedAt || ""}`,
    `Definition: ${run.definitionFile}`,
    `State: ${run.runDir}`,
    run.error ? `Error: ${run.error.message}` : "",
  ].filter(Boolean).join("\n") + "\n";
}

function formatWorkflowEvents(events) {
  if (!events.length) return "Events: none\n";
  const lines = ["Events:"];
  for (const event of events) {
    const step = event.stepId ? ` step=${event.stepId}` : "";
    const status = event.status ? ` status=${event.status}` : "";
    const artifact = event.artifact?.path ? ` artifact=${path.basename(event.artifact.path)}` : "";
    const error = event.error?.message ? ` error=${event.error.message}` : "";
    lines.push(`  ${event.time} ${event.event}${step}${status}${artifact}${error}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatWorkflowTable(runs) {
  const rows = runs.map((run) => ({
    status: run.status,
    workflowRunId: run.workflowRunId,
    name: run.name,
    started: run.startedAt,
    completed: run.endedAt || "",
  }));
  return formatTable(rows, ["status", "workflowRunId", "name", "started", "completed"]);
}

function formatTable(rows, columns) {
  const headers = columns.map((column) => column.toUpperCase());
  const widths = columns.map((column, index) =>
    Math.max(headers[index].length, ...rows.map((row) => String(row[column] ?? "").length)),
  );
  const lines = [
    headers.map((header, index) => header.padEnd(widths[index])).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
  ];
  for (const row of rows) {
    lines.push(columns.map((column, index) => String(row[column] ?? "").padEnd(widths[index])).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

function workflowHelpText() {
  return `relaymux workflow - run foreground TypeScript workflows

Usage:
  relaymux workflow run <file> --name <name> [--input-json <json>] [--input-file <path>] [--idempotency-key <key>] [--json]
  relaymux workflow status [workflowRunId] [--json] [--events]
  relaymux workflow list [--json]

Notes:
  Workflows run in the foreground for this MVP and persist state under <stateDir>/workflows/<workflowRunId>.
  Workflow files may import defineWorkflow and shell from @relaymux/workflows when run through relaymux workflow run.
  workflow status without a workflowRunId is an interactive alias for workflow list; --events requires a workflowRunId.
`;
}
