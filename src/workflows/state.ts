import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDirectory } from "../paths.js";

export const WORKFLOW_TERMINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "canceled"]);
export const WORKFLOW_RETRYABLE_TERMINAL_STATUSES = new Set(["failed", "timed_out", "canceled"]);
export const WORKFLOW_RUN_ID_PATTERN = /^wf-[a-z0-9]+-[a-f0-9]{8}$/;

export class WorkflowIdempotencyConflictError extends Error {
  constructor({ name, existingRun, requested }: any) {
    const existingRunId = existingRun?.workflowRunId ? ` Existing run: ${existingRun.workflowRunId}.` : "";
    super(
      `Idempotency conflict for workflow "${name}": this key was already used with a different workflow definition or input.${existingRunId} Use the original definition/input or a different --idempotency-key.`,
    );
    this.name = "WorkflowIdempotencyConflictError";
    (this as any).existingRun = existingRun || null;
    (this as any).requested = requested;
  }
}

export function makeWorkflowRunId() {
  const workflowRunId = `wf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  validateWorkflowRunId(workflowRunId);
  return workflowRunId;
}

export function workflowsDir(stateDir) {
  return path.join(stateDir, "workflows");
}

export function validateWorkflowRunId(workflowRunId) {
  const value = String(workflowRunId || "");
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    !WORKFLOW_RUN_ID_PATTERN.test(value)
  ) {
    throw new Error(`Invalid workflow run id ${JSON.stringify(value)}; expected wf-<base36time>-<hex8>`);
  }
  return value;
}

export function isWorkflowRunId(value) {
  if (typeof value !== "string") return false;
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) return false;
  return WORKFLOW_RUN_ID_PATTERN.test(value);
}

export function resolveWorkflowRunDir(stateDir, workflowRunId) {
  const runId = validateWorkflowRunId(workflowRunId);
  const root = path.resolve(workflowsDir(stateDir));
  const resolved = path.resolve(root, runId);
  if (!isPathInside(root, resolved)) {
    throw new Error(`Invalid workflow run id ${JSON.stringify(runId)}; resolved outside workflow state`);
  }
  return resolved;
}

export function workflowRunDir(stateDir, workflowRunId) {
  return resolveWorkflowRunDir(stateDir, workflowRunId);
}

export function createWorkflowRun({
  stateDir,
  workflowRunId = makeWorkflowRunId(),
  name,
  definitionFile,
  definitionHash,
  inputHash,
  input,
  idempotencyKey = "",
}: any) {
  validateWorkflowRunId(workflowRunId);
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
    inputHash: inputHash || hashJson(input ?? {}),
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
    .filter((entry) => entry.isDirectory() && isWorkflowRunId(entry.name))
    .map((entry) => readWorkflowRun(stateDir, entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}

export async function reserveWorkflowRunForIdempotency({
  stateDir,
  name,
  definitionFile,
  definitionHash,
  inputHash,
  input,
  idempotencyKey,
}: any) {
  const normalizedKey = String(idempotencyKey || "");
  if (!normalizedKey) {
    return {
      reused: false,
      run: createWorkflowRun({ stateDir, name, definitionFile, definitionHash, inputHash, input, idempotencyKey: "" }),
    };
  }

  const slot = idempotencySlot(name, normalizedKey);
  const release = await acquireIdempotencyLock(stateDir, slot);
  try {
    const recordPath = idempotencyRecordPath(stateDir, slot);
    const existingRecord = readJsonFile(recordPath);
    const requested = {
      name,
      idempotencyKey: normalizedKey,
      definitionHash,
      inputHash,
    };

    if (existingRecord) {
      const existingRun = existingRecord.workflowRunId ? readWorkflowRun(stateDir, existingRecord.workflowRunId) : null;
      const sameRequest =
        existingRecord.name === name &&
        existingRecord.idempotencyKey === normalizedKey &&
        existingRecord.definitionHash === definitionHash &&
        existingRecord.inputHash === inputHash;

      if (!sameRequest) {
        throw new WorkflowIdempotencyConflictError({ name, existingRun, requested });
      }

      if (existingRun && !WORKFLOW_RETRYABLE_TERMINAL_STATUSES.has(existingRun.status)) {
        return { reused: true, run: existingRun };
      }
    }

    const run = createWorkflowRun({
      stateDir,
      name,
      definitionFile,
      definitionHash,
      inputHash,
      input,
      idempotencyKey: normalizedKey,
    });
    writeJsonFile(recordPath, {
      ...requested,
      workflowRunId: run.workflowRunId,
      updatedAt: new Date().toISOString(),
    });
    return { reused: false, run };
  } finally {
    release();
  }
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

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function idempotencyDir(stateDir) {
  return path.join(workflowsDir(stateDir), ".idempotency");
}

function idempotencySlot(name, idempotencyKey) {
  return createHash("sha256")
    .update(stableStringify({ name: String(name), idempotencyKey: String(idempotencyKey) }))
    .digest("hex");
}

function idempotencyRecordPath(stateDir, slot) {
  return path.join(idempotencyDir(stateDir), `${slot}.json`);
}

async function acquireIdempotencyLock(stateDir, slot) {
  const root = idempotencyDir(stateDir);
  ensureDirectory(root);
  const lockDir = path.join(root, `${slot}.lock`);
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeJsonFile(path.join(lockDir, "lock.json"), {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
      return () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - startedAt > 30_000) {
        throw new Error("Timed out waiting for workflow idempotency reservation lock");
      }
      await delay(25);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
