import { createAgentWindow, sendShellCommand, setWindowMetadata } from "../tmux.js";
import { recordRun } from "../state.js";

import { prepareLaunchArtifacts } from "./artifacts.js";

export function launchLocalTmux(request) {
  const sessionInfo = request.sessionInfo;
  if (!sessionInfo?.session) {
    throw new Error("local-tmux executor requires a resolved tmux session");
  }

  const artifacts = prepareLaunchArtifacts(request, { writeFiles: !request.dryRun });

  if (request.dryRun) {
    request.io.stdout.write(`# tmux session: ${sessionInfo.session} (${sessionInfo.mode}; ${sessionInfo.source})\n`);
    if (request.worktreeAddArgs) {
      request.io.stdout.write(`worktree: ${request.quoteArgv(["git", ...request.worktreeAddArgs])}\n`);
    }
    request.io.stdout.write(`${artifacts.shellCommand}\n`);
    request.io.stdout.write("\n# wrapper script\n");
    request.io.stdout.write(`${artifacts.script}\n`);
    return { executor: "local-tmux", dryRun: true, ...artifacts };
  }

  if (request.printCommand) {
    request.io.stdout.write(`${artifacts.shellCommand}\n`);
  }

  const target = createAgentWindow({
    session: sessionInfo.session,
    name: request.name,
    cwd: request.workdir,
  });

  const started = new Date().toISOString();
  setWindowMetadata(target.windowTarget, {
    relaymux: "1",
    relaymux_agent: request.agentName,
    relaymux_agent_requested: request.requestedAgent,
    relaymux_executor: "local-tmux",
    relaymux_group: request.group,
    relaymux_name: request.name,
    relaymux_repo: request.repo,
    relaymux_run_id: request.runId,
    relaymux_session: sessionInfo.session,
    relaymux_session_mode: sessionInfo.mode,
    relaymux_started: started,
  });
  sendShellCommand(target.target, artifacts.shellCommand);

  recordRun(request.stateDir, {
    time: started,
    runId: request.runId,
    executor: "local-tmux",
    group: request.group,
    session: sessionInfo.session,
    sessionMode: sessionInfo.mode,
    sessionSource: sessionInfo.source,
    target: target.target,
    windowTarget: target.windowTarget,
    name: request.name,
    agent: request.agentName,
    requestedAgent: request.requestedAgent,
    repo: request.repo,
    workdir: request.workdir,
    promptFile: artifacts.promptFile,
    scriptFile: artifacts.scriptFile,
    command: artifacts.shellCommand,
  });

  request.io.stdout.write(`Started ${request.name} in tmux session ${sessionInfo.session} tab ${target.windowTarget} (target ${target.target})\n`);
  request.io.stdout.write(`Run ID: ${request.runId}\n`);
  if (request.attach) {
    request.io.stdout.write(`Attach with: tmux attach -t ${sessionInfo.session}\n`);
  }
  return { executor: "local-tmux", target, ...artifacts };
}
