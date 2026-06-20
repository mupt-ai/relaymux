const AGENT_ALIASES = new Map([
  ["cc", "claude"],
  ["claude-code", "claude"],
]);

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
      aliasOf: "",
    };
  }

  const aliasOf = AGENT_ALIASES.get(requested.toLowerCase());
  if (aliasOf && agents[aliasOf]) {
    return {
      requestedAgent: requested,
      agentName: aliasOf,
      agentConfig: agents[aliasOf],
      aliasOf,
    };
  }

  const aliasHint = aliasOf ? ` Alias "${requested}" maps to "${aliasOf}", but that agent is not configured.` : "";
  throw new Error(`Unknown agent "${requested}". Add it to your config under agents.${aliasHint}`);
}

