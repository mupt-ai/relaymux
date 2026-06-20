import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { ensureDirectory } from "../paths.js";
import { quoteArgv } from "../command.js";
import { recordEvent, recordRun } from "../state.js";

import { prepareLaunchArtifacts } from "./artifacts.js";

export function backgroundLogPaths(stateDir, runId) {
  const logDir = path.join(stateDir, "logs");
  return {
    logDir,
    stdoutLog: path.join(logDir, `${runId}.out.log`),
    stderrLog: path.join(logDir, `${runId}.err.log`),
  };
}

export function launchLocalBackground(request) {
  if (request.holdOnExit) {
    throw new Error("--hold is only supported with the local-tmux executor; local-background runs detach and write logs instead.");
  }

  const artifacts = prepareLaunchArtifacts(request, { writeFiles: !request.dryRun });
  const logs = backgroundLogPaths(request.stateDir, request.runId);
  const command = quoteArgv(["/bin/sh", artifacts.scriptFile]);

  if (request.dryRun) {
    request.io.stdout.write("# executor: local-background\n");
    if (request.group) request.io.stdout.write(`# group: ${request.group}\n`);
    if (request.worktreeAddArgs) {
      request.io.stdout.write(`worktree: ${request.quoteArgv(["git", ...request.worktreeAddArgs])}\n`);
    }
    request.io.stdout.write(`# cwd: ${request.workdir}\n`);
    request.io.stdout.write(`# stdout: ${logs.stdoutLog}\n`);
    request.io.stdout.write(`# stderr: ${logs.stderrLog}\n`);
    request.io.stdout.write(`${command}\n`);
    request.io.stdout.write("\n# wrapper script\n");
    request.io.stdout.write(`${artifacts.script}\n`);
    return { executor: "local-background", dryRun: true, logs, ...artifacts };
  }

  if (request.printCommand) {
    request.io.stdout.write(`${command}\n`);
  }

  ensureDirectory(logs.logDir);
  const stdoutFd = fs.openSync(logs.stdoutLog, "a");
  const stderrFd = fs.openSync(logs.stderrLog, "a");
  let child;
  try {
    child = spawn("/bin/sh", [artifacts.scriptFile], {
      cwd: request.workdir,
      detached: true,
      env: { ...process.env, ...(request.env || {}) },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.unref();

  const started = new Date().toISOString();
  const pid = child.pid;
  recordRun(request.stateDir, {
    time: started,
    runId: request.runId,
    executor: "local-background",
    group: request.group,
    target: pid ? `pid:${pid}` : "",
    pid,
    name: request.name,
    agent: request.agentName,
    requestedAgent: request.requestedAgent,
    repo: request.repo,
    workdir: request.workdir,
    promptFile: artifacts.promptFile,
    scriptFile: artifacts.scriptFile,
    command,
    stdoutLog: logs.stdoutLog,
    stderrLog: logs.stderrLog,
    logs,
  });
  recordEvent(request.stateDir, {
    time: started,
    runId: request.runId,
    event: "launched",
    message: pid ? `background process started pid ${pid}` : "background process started",
    agent: request.agentName,
    name: request.name,
    repo: request.repo,
  });

  request.io.stdout.write(`Started ${request.name} as local background process${pid ? ` pid ${pid}` : ""}\n`);
  request.io.stdout.write(`Run ID: ${request.runId}\n`);
  request.io.stdout.write(`Logs: ${logs.stdoutLog} ${logs.stderrLog}\n`);
  return { executor: "local-background", pid, logs, ...artifacts };
}
