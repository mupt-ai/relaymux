import fs from "node:fs";
import path from "node:path";

import { expandPath } from "../paths.js";

import { WorkflowContext } from "./context.js";
import { loadWorkflowDefinition } from "./loader.js";
import {
  appendWorkflowEvent,
  createWorkflowRun,
  findWorkflowRunByIdempotencyKey,
  hashFile,
  readWorkflowRun,
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

  const existing = findWorkflowRunByIdempotencyKey(stateDir, String(name), String(idempotencyKey || ""));
  if (existing) {
    return { reused: true, run: existing, result: null };
  }

  const run = createWorkflowRun({
    stateDir,
    name: String(name),
    definitionFile,
    definitionHash: hashFile(definitionFile),
    input: input ?? {},
    idempotencyKey: String(idempotencyKey || ""),
  });

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
    const context = new WorkflowContext({ stateDir, run, input, cwd: path.dirname(definitionFile) });
    const result = await definition.run(context, input ?? {});
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
    writeJsonFile(run.resultPath, { ok: false, error: summary });
    const latestRun = readWorkflowRun(stateDir, run.workflowRunId) || run;
    const failed = updateWorkflowRun(stateDir, run.workflowRunId, {
      status: "failed",
      endedAt,
      error: summary,
      summary: {
        ...(latestRun.summary || {}),
        lastError: summary.message,
      },
    });
    appendWorkflowEvent(stateDir, run.workflowRunId, {
      event: "workflow_failed",
      status: "failed",
      error: summary,
      resultPath: run.resultPath,
    });
    return { reused: false, run: failed, result: null, error: summary };
  }
}
