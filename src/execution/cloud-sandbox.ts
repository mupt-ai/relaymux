import { quoteArgv, renderTemplate, shellExportBlock } from "../command.js";

import { prepareLaunchArtifacts } from "./artifacts.js";

export function launchCloudSandbox(request) {
  const adapter = resolveCloudSandboxAdapter(request.config);
  if (!request.dryRun) {
    throw new Error(`cloud-sandbox provider "${adapter.provider}" is configured, but relaymux does not include a live cloud launch adapter in this build. Configure a supported adapter before using --executor cloud-sandbox.`);
  }

  const artifacts = prepareLaunchArtifacts(request, { writeFiles: !request.dryRun });
  const command = buildCloudAdapterCommand(adapter, request, artifacts);

  request.io.stdout.write("# executor: cloud-sandbox\n");
  request.io.stdout.write(`# provider: ${adapter.provider}\n`);
  if (request.group) request.io.stdout.write(`# group: ${request.group}\n`);
  if (request.worktreeAddArgs) {
    request.io.stdout.write(`worktree: ${request.quoteArgv(["git", ...request.worktreeAddArgs])}\n`);
  }
  request.io.stdout.write(`${command}\n`);
  request.io.stdout.write("\n# wrapper script\n");
  request.io.stdout.write(`${artifacts.script}\n`);
  return { executor: "cloud-sandbox", dryRun: true, command, ...artifacts };
}

export function resolveCloudSandboxAdapter(config) {
  const adapter = config.execution?.cloudSandbox || {};
  const provider = String(adapter.provider || "").trim();
  const command = adapter.command;

  if (!provider || !Array.isArray(command) || command.length === 0) {
    throw new Error("cloud-sandbox executor is not configured. Set execution.cloudSandbox.provider and execution.cloudSandbox.command in relaymux config before using --executor cloud-sandbox.");
  }

  return {
    provider,
    command,
    env: adapter.env || {},
  };
}

function buildCloudAdapterCommand(adapter, request, artifacts) {
  const context = {
    agent: request.agentName,
    requestedAgent: request.requestedAgent,
    group: request.group,
    name: request.name,
    prompt: request.prompt,
    promptFile: artifacts.promptFile,
    repo: request.repo,
    runId: request.runId,
    scriptFile: artifacts.scriptFile,
    workdir: request.workdir,
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(adapter.env || {})) {
    env[key] = renderTemplate(value, context);
  }
  const exports = Object.keys(env).length ? `${shellExportBlock(env)}\n` : "";
  const argv = adapter.command.map((part) => renderTemplate(part, context));
  return `${exports}${quoteArgv(argv)}`;
}
