import fs from "node:fs";
import path from "node:path";

import { ensureDirectory } from "../paths.js";

import {
  appendWorkflowEvent,
  hashJson,
  readJsonFile,
  safeErrorSummary,
  safePathSegment,
  updateWorkflowRun,
  writeJsonFile,
} from "./state.js";

export class WorkflowStepError extends Error {
  result: any;
  stepId: string;

  constructor(stepId, result) {
    super(`Workflow step "${stepId}" failed with status ${result.status || "failed"}`);
    this.name = "WorkflowStepError";
    this.stepId = stepId;
    this.result = result;
  }
}

export class WorkflowContext {
  stateDir: string;
  run: any;
  input: any;
  cwd: string;

  constructor({ stateDir, run, input, cwd }: any) {
    this.stateDir = stateDir;
    this.run = run;
    this.input = input;
    this.cwd = cwd || process.cwd();
  }

  get workflowRunId() {
    return this.run.workflowRunId;
  }

  get runDir() {
    return this.run.runDir;
  }

  get name() {
    return this.run.name;
  }

  async step(stepId, runnable) {
    validateRunnable(runnable);
    const displayStepId = String(stepId || "").trim();
    if (!displayStepId) {
      throw new Error("ctx.step(stepId, runnable) requires a non-empty stepId");
    }

    const description = runnable.describe();
    const inputDigest = hashJson(description);
    const stepDir = path.join(this.runDir, "steps", safePathSegment(displayStepId, "step"));
    const previous = readJsonFile(path.join(stepDir, "step.json"));
    if (previous?.status === "succeeded" && previous.inputDigest === inputDigest && previous.resultPath) {
      const cached = readJsonFile(previous.resultPath);
      if (cached) return cached;
    }

    const attempt = Number(previous?.attempt || 0) + 1;
    const attemptDir = path.join(stepDir, "attempts", String(attempt));
    ensureDirectory(attemptDir);
    const startedAt = new Date().toISOString();
    const stepRecord = {
      stepId: displayStepId,
      safeStepId: safePathSegment(displayStepId, "step"),
      displayName: displayStepId,
      kind: runnable.kind,
      attempt,
      status: "running",
      inputDigest,
      startedAt,
      endedAt: "",
      resultPath: path.join(attemptDir, "result.json"),
      artifacts: {},
    };
    writeJsonFile(path.join(stepDir, "step.json"), stepRecord);
    updateWorkflowRun(this.stateDir, this.workflowRunId, {
      summary: {
        ...(this.run.summary || {}),
        currentStep: displayStepId,
      },
    });
    this.run = { ...this.run, summary: { ...(this.run.summary || {}), currentStep: displayStepId } };

    appendWorkflowEvent(this.stateDir, this.workflowRunId, {
      event: "step_started",
      stepId: displayStepId,
      kind: runnable.kind,
      attempt,
      description,
    });

    try {
      const result = await runnable.execute({
        workflowRunId: this.workflowRunId,
        runDir: this.runDir,
        stepId: displayStepId,
        attempt,
        attemptDir,
        cwd: this.cwd,
      });
      const completedRecord = completeStepRecord(stepRecord, result);
      writeJsonFile(stepRecord.resultPath, result);
      writeJsonFile(path.join(stepDir, "step.json"), completedRecord);
      emitStepArtifacts(this.stateDir, this.workflowRunId, displayStepId, attempt, result.artifacts);
      appendWorkflowEvent(this.stateDir, this.workflowRunId, {
        event: result.ok ? "step_completed" : "step_failed",
        stepId: displayStepId,
        kind: runnable.kind,
        attempt,
        status: result.status,
        artifacts: result.artifacts || {},
        result: summarizeResult(result),
      });

      if (!result.ok && !runnable.allowFailure) {
        throw new WorkflowStepError(displayStepId, result);
      }
      return result;
    } catch (error) {
      if (error instanceof WorkflowStepError) throw error;
      const failed = {
        ok: false,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        error: safeErrorSummary(error),
        artifacts: {},
      };
      writeJsonFile(stepRecord.resultPath, failed);
      writeJsonFile(path.join(stepDir, "step.json"), completeStepRecord(stepRecord, failed));
      appendWorkflowEvent(this.stateDir, this.workflowRunId, {
        event: "step_failed",
        stepId: displayStepId,
        kind: runnable.kind,
        attempt,
        status: failed.status,
        error: failed.error,
      });
      throw error;
    }
  }

  emit(event, data: any = {}) {
    return appendWorkflowEvent(this.stateDir, this.workflowRunId, {
      event: String(event || "workflow_event"),
      data,
    });
  }

  artifact(name, content) {
    const file = path.join(this.runDir, "artifacts", safePathSegment(name, "artifact"));
    ensureDirectory(path.dirname(file));
    if (Buffer.isBuffer(content) || typeof content === "string") {
      fs.writeFileSync(file, content, { mode: 0o600 });
    } else {
      writeJsonFile(file, content);
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    appendWorkflowEvent(this.stateDir, this.workflowRunId, {
      event: "artifact",
      artifact: {
        name: String(name),
        path: file,
      },
    });
    return file;
  }
}

function validateRunnable(runnable) {
  if (!runnable || typeof runnable !== "object") {
    throw new Error("ctx.step requires a runnable object");
  }
  if (!runnable.kind || typeof runnable.execute !== "function" || typeof runnable.describe !== "function") {
    throw new Error("ctx.step runnable must define kind, describe(), and execute()");
  }
}

function completeStepRecord(stepRecord, result) {
  const endedAt = result.endedAt || new Date().toISOString();
  return {
    ...stepRecord,
    status: result.status || (result.ok ? "succeeded" : "failed"),
    endedAt,
    resultPath: stepRecord.resultPath,
    artifacts: result.artifacts || {},
    error: result.error || null,
  };
}

function emitStepArtifacts(stateDir, workflowRunId, stepId, attempt, artifacts = {}) {
  for (const [name, artifactPath] of Object.entries(artifacts)) {
    appendWorkflowEvent(stateDir, workflowRunId, {
      event: "artifact",
      stepId,
      attempt,
      artifact: {
        name,
        path: artifactPath,
      },
    });
  }
}

function summarizeResult(result) {
  const data = result.data || {};
  return {
    ok: Boolean(result.ok),
    status: result.status || "",
    exitCode: data.exitCode ?? null,
    signal: data.signal ?? null,
    timedOut: Boolean(data.timedOut),
    stdoutSnippet: data.stdoutSnippet || "",
    stderrSnippet: data.stderrSnippet || "",
  };
}
