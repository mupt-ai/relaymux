export function resolveAgentConfig(config, requestedAgent) {
  const requested = String(requestedAgent || "").trim();
  if (!requested) {
    throw new Error("Missing --agent <name>");
  }

  const agents = config.agents || {};
  if (agents[requested]) {
    return {
      requestedAgent: requested,
      agentName: requested,
      agentConfig: agents[requested],
    };
  }

  throw new Error(`Unknown agent "${requested}". Add it to your config under agents.`);
}
