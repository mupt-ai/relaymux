import { findExecutable } from "./doctor.js";

export function buildSetupAgents(options: any = {}, env = process.env) {
  const agents: Record<string, any> = {
    custom: {
      description: "Placeholder agent used when no local coding-agent CLI is installed.",
      command: ["/bin/sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""],
      promptMode: "env",
    },
  };

  const pi = options.piPath || findExecutable("pi", env);
  const codex = options.codexPath || findExecutable("codex", env);
  const claude = options.claudePath || findExecutable("claude", env);

  if (pi) {
    agents.pi = {
      description: "Default Pi subagent launched in tmux.",
      command: [pi, "{prompt}"],
      promptMode: "arg",
    };
  }
  if (codex) {
    agents.codex = {
      description: "Codex subagent. Edit flags to match your local install.",
      command: [codex, "{prompt}"],
      promptMode: "arg",
    };
  }
  if (claude) {
    agents.claude = {
      description: "Claude subagent.",
      command: [claude, "{prompt}"],
      promptMode: "arg",
    };
  }

  return agents;
}

export function buildSetupOrchestrator(options: any = {}, env = process.env) {
  const sessionDir = options.sessionDir || (options.stateDir ? `${options.stateDir}/sessions` : "~/.relaymux/state/sessions");
  const pi = options.piPath || findExecutable("pi", env);
  const cwd = options.cwd || "~";
  if (pi) {
    return {
      cwd,
      command: [pi, "--print", "--continue", "--session-dir", sessionDir, "{prompt}"],
      promptMode: "arg",
    };
  }

  return {
    description: "Placeholder orchestrator. Install pi or edit ~/.relaymux/config.json to use a real local agent CLI.",
    placeholder: true,
    cwd,
    command: ["/bin/sh", "-lc", "printf '%s\\n' 'relaymux Telegram transport is running, but no orchestrator CLI is configured yet. Install pi or edit ~/.relaymux/config.json to point orchestrator.command at your agent.'"],
    promptMode: "env",
  };
}
