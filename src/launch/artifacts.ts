import path from "node:path";

import { buildAgentInvocation, buildTmuxShellCommand, buildTmuxShellScript } from "../command.js";
import { writePromptFile, writeScriptFile } from "../state.js";

function buildLaunchShellScript(agentName, agentConfig, context) {
  const invocation = buildAgentInvocation(agentName, agentConfig, context);
  return buildTmuxShellScript(invocation, context);
}

export function prepareLaunchArtifacts(request, { writeFiles = true } = {}) {
  const promptFile = writeFiles
    ? writePromptFile(request.stateDir, request.runId, request.prompt)
    : path.join(request.stateDir, "prompts", `${request.runId}.txt`);
  const script = buildLaunchShellScript(request.agentName, request.agentConfig, {
    agent: request.agentName,
    cliPath: request.cliPath,
    configPath: request.configPath,
    holdOnExit: request.holdOnExit,
    launchNotification: request.launchNotification,
    name: request.name,
    prompt: request.prompt,
    promptFile,
    repo: request.repo,
    runId: request.runId,
    session: request.session || "",
    workdir: request.workdir,
  });
  const scriptFile = writeFiles
    ? writeScriptFile(request.stateDir, request.runId, script)
    : path.join(request.stateDir, "scripts", `${request.runId}.sh`);

  return {
    promptFile,
    script,
    scriptFile,
    shellCommand: buildTmuxShellCommand(scriptFile),
  };
}

