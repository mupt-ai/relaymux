import fs from "node:fs";
import path from "node:path";

import { expandPath } from "../paths.js";

import { WorkflowContext, WorkflowStepError } from "./context.js";
import { loadWorkflowDefinition } from "./loader.js";
import {
  appendWorkflowEvent,
  hashFile,
  hashJson,
  readWorkflowRun,
  reserveWorkflowRunForIdempotency,
  safeErrorSummary,
  updateWorkflowRun,
  writeJsonFile,
} from "./state.js";

export async function runWorkflow({ file, name, input = {}, idempotencyKey = "", stateDir, cwd = process.cwd() }: any) {
  if (!file) throw new Error("Missing workflow file");
  if (!name) throw new Error("Missing --name <name>");

  const definitionFile = expandPath(file, cwd);
  if (!fs.existsSync(definitionFile) || !fs.statSync(definitionFile).isFile()) {
    throw new Error(`Workflow file does not exist: ${definitionFile}`);
  }

  const workflowInput = input ?? {};
  const definitionHash = hashFile(definitionFile);
  const inputHash = hashJson(workflowInput);
  const reservation = await reserveWorkflowRunForIdempotency({
    stateDir,
    name: String(name),
    definitionFile,
    definitionHash,
    inputHash,
    input: workflowInput,
    idempotencyKey: String(idempotencyKey || ""),
  });
  if (reservation.reused) {
    return { reused: true, run: reservation.run, result: null };
  }

  const run = reservation.run;

  appendWorkflowEvent(stateDir, run.workflowRunId, {
    event: "workflow_started",
    name: run.name,
    definitionFile: run.definitionFile,
    definitionHash: run.definitionHash,
    inputHash: run.inputHash,
    idempotencyKey: run.idempotencyKey,
  });

  try {
    const definition = await loadWorkflowDefinition({ definitionFile, runDir: run.runDir });
    const context = new WorkflowContext({ stateDir, run, input: workflowInput, cwd: path.dirname(definitionFile) });
    const result = await definition.run(context, workflowInput);
    const endedAt = new Date().toISOString();
    writeJsonFile(run.resultPath, result ?? null);
    const latestRun = readWorkflowRun(stateDir, run.workflowRunId) || run;
    const completed = updateWorkflowRun(stateDir, run.workflowRunId, {
      status: "succeeded",
      endedAt,
      summary: {
        ...(latestRun.summary || {}),
        definitionName: definition.name || "",
      },
    });
    appendWorkflowEvent(stateDir, run.workflowRunId, {
      event: "workflow_completed",
      status: "succeeded",
      resultPath: run.resultPath,
    });
    return { reused: false, run: completed, result };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const summary = safeErrorSummary(error);
    const status = workflowStatusForError(error);
    writeJsonFile(run.resultPath, { ok: false, error: summary });
    const latestRun = readWorkflowRun(stateDir, run.workflowRunId) || run;
    const failed = updateWorkflowRun(stateDir, run.workflowRunId, {
      status,
      endedAt,
      error: summary,
      summary: {
        ...(latestRun.summary || {}),
        lastError: summary.message,
      },
    });
    appendWorkflowEvent(stateDir, run.workflowRunId, {
      event: status === "timed_out" ? "workflow_timed_out" : "workflow_failed",
      status,
      error: summary,
      resultPath: run.resultPath,
    });
    return { reused: false, run: failed, result: null, error: summary };
  }
}

function workflowStatusForError(error) {
  if (error instanceof WorkflowStepError && error.result?.status === "timed_out") {
    return "timed_out";
  }
  return "failed";
}
