import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { resolveAgentConfig } from "../src/launch/agents.js";

test("agent names resolve exactly from config", () => {
  const config = defaultConfig();

  const resolved = resolveAgentConfig(config, "claude");

  assert.equal(resolved.agentName, "claude");
  assert.deepEqual(resolved.agentConfig.command, config.agents.claude.command);
  assert.throws(() => resolveAgentConfig(config, "cc"), /Unknown agent "cc"/);
});
