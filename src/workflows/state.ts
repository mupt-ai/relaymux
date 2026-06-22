import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDirectory } from "../paths.js";

export const WORKFLOW_TERMINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "canceled"]);

export function makeWorkflowRunId() {
  return `wf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function workflowsDir(stateDir) {
  return path.join(stateDir, "workflows");
}

export function workflowRunDir(stateDir, workflowRunId) {
  return path.join(workflowsDir(stateDir), workflowRunId);
}

export function createWorkflowRun({
  stateDir,
  workflowRunId = makeWorkflowRunId(),
  name,
  definitionFile,
  definitionHash,
  input,
  idempotencyKey = "",
}: any) {
  const startedAt = new Date().toISOString();
  const runDir = workflowRunDir(stateDir, workflowRunId);
  ensureDirectory(runDir);

  const inputPath = path.join(runDir, "input.json");
  writeJsonFile(inputPath, input ?? {});

  const run = {
    workflowRunId,
    name,
    definitionFile,
    definitionHash,
    inputHash: hashJson(input ?? {}),
    idempotencyKey,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    endedAt: "",
    runDir,
    inputPath,
    resultPath: path.join(runDir, "result.json"),
    eventsPath: path.join(runDir, "events.jsonl"),
    summary: {},
  };

  writeWorkflowRun(stateDir, run);
  appendJsonl(path.join(workflowsDir(stateDir), "runs.jsonl"), run);
  return run;
}

export function writeWorkflowRun(stateDir, run) {
  const runDir = workflowRunDir(stateDir, run.workflowRunId);
  ensureDirectory(runDir);
  writeJsonFile(path.join(runDir, "run.json"), { ...run, runDir });
}

export function updateWorkflowRun(stateDir, workflowRunId, patch) {
  const existing = readWorkflowRun(stateDir, workflowRunId);
  if (!existing) {
    throw new Error(`Unknown workflow run "${workflowRunId}"`);
  }
  const updated = {
    ...existing,
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  writeWorkflowRun(stateDir, updated);
  return updated;
}

export function readWorkflowRun(stateDir, workflowRunId) {
  const file = path.join(workflowRunDir(stateDir, workflowRunId), "run.json");
  return readJsonFile(file);
}

export function listWorkflowRuns(stateDir) {
  const root = workflowsDir(stateDir);
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readWorkflowRun(stateDir, entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}

export function findWorkflowRunByIdempotencyKey(stateDir, name, idempotencyKey) {
  if (!idempotencyKey) return null;
  return listWorkflowRuns(stateDir).find((run) =>
    run.name === name && run.idempotencyKey === idempotencyKey,
  ) || null;
}

export function appendWorkflowEvent(stateDir, workflowRunId, event) {
  const run = readWorkflowRun(stateDir, workflowRunId);
  if (!run) {
    throw new Error(`Unknown workflow run "${workflowRunId}"`);
  }

  const record = {
    time: event.time || new Date().toISOString(),
    workflowRunId,
    event: event.event,
    ...event,
  };
  appendJsonl(path.join(workflowRunDir(stateDir, workflowRunId), "events.jsonl"), record);
  return record;
}

export function readWorkflowEvents(stateDir, workflowRunId) {
  return readJsonl(path.join(workflowRunDir(stateDir, workflowRunId), "events.jsonl"));
}

export function writeJsonFile(file, value) {
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function hashJson(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function safePathSegment(value, fallback = "item") {
  const segment = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return segment || fallback;
}

export function safeErrorSummary(error) {
  const message = error?.message ? String(error.message) : String(error);
  return {
    name: error?.name ? String(error.name).slice(0, 120) : "Error",
    message: message.slice(0, 1000),
  };
}

export function stableStringify(value) {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortForJson(item));
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForJson(value[key]);
    }
    return sorted;
  }
  return value;
}

function appendJsonl(file, value) {
  ensureDirectory(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
