import path from "node:path";

import { defaultConfig, defaultTelegramIntegration } from "./config.js";
import { findExecutable } from "./doctor.js";
import { expandPath } from "./paths.js";

export function buildTelegramIntegration(options: any = {}) {
  const defaults = defaultTelegramIntegration();
  return {
    ...defaults,
    enabled: true,
    chatId: options.telegramChatId || options.chatId || "TELEGRAM_CHAT_ID",
    botTokenEnv: options.telegramBotTokenEnv || (options.telegramBotTokenFile ? "" : defaults.botTokenEnv),
    botTokenFile: options.telegramBotTokenFile || "",
    parseMode: options.telegramParseMode || options.parseMode || "",
    apiBaseUrl: options.telegramApiBaseUrl || options.apiBaseUrl || defaults.apiBaseUrl,
    timeoutMs: Number(options.telegramTimeoutMs || options.timeoutMs || defaults.timeoutMs),
    maxMessageChars: Number(options.telegramMaxMessageChars || options.maxMessageChars || defaults.maxMessageChars),
  };
}

export function withTelegramIntegration(config, options: any = {}) {
  return {
    ...config,
    integrations: {
      ...(config.integrations || {}),
      telegram: buildTelegramIntegration(options),
    },
    launchNotifications: {
      ...(config.launchNotifications || {}),
      replyMode: options.defaultReplyMode || config.launchNotifications?.replyMode || "telegram",
    },
  };
}

export function buildTelegramConfig(options: any = {}, env = process.env) {
  const base = defaultConfig(env);
  const stateDir = options.stateDir || base.stateDir;
  const sessionDir = path.posix.join(stateDir, "sessions");
  const logDir = options.logDir || (options.stateDir ? path.posix.join(stateDir, "logs") : base.daemon.logDir);
  const pi = options.piPath || findExecutable("pi", env) || "pi";
  const codex = options.codexPath || findExecutable("codex", env) || "codex";
  const claude = options.claudePath || findExecutable("claude", env) || "claude";
  const cwd = options.cwd || "~";

  return withTelegramIntegration({
    ...base,
    session: options.session || base.session,
    stateDir,
    daemon: {
      ...base.daemon,
      port: Number(options.port || base.daemon.port),
      tokenFile: path.posix.join(stateDir, "webhook-token"),
      launchAgentLabel: options.launchAgentLabel || base.daemon.launchAgentLabel,
      logDir,
    },
    orchestrator: {
      ...base.orchestrator,
      cwd,
      command: [pi, "--print", "--continue", "--session-dir", sessionDir, "{prompt}"],
      promptMode: "arg",
    },
    agents: {
      pi: {
        description: "Default Pi subagent launched in tmux.",
        command: [pi, "{prompt}"],
        promptMode: "arg",
      },
      codex: {
        description: "Codex subagent. Edit flags to match your local install.",
        command: [codex, "{prompt}"],
        promptMode: "arg",
      },
      claude: {
        description: "Claude subagent.",
        command: [claude, "{prompt}"],
        promptMode: "arg",
      },
    },
  }, { ...options, defaultReplyMode: options.defaultReplyMode || "telegram" });
}

export function initTelegramOptionsFromFlags(flags) {
  return {
    telegramChatId: flags.telegramChatId,
    telegramBotTokenEnv: flags.telegramBotTokenEnv,
    telegramBotTokenFile: flags.telegramBotTokenFile,
    telegramParseMode: flags.telegramParseMode,
    telegramTimeoutMs: flags.telegramTimeoutMs,
    telegramApiBaseUrl: flags.telegramApiBaseUrl,
    telegramMaxMessageChars: flags.telegramMaxMessageChars,
    cwd: flags.cwd ? expandPath(flags.cwd) : undefined,
    stateDir: flags.stateDir,
    session: flags.session,
    port: flags.port,
    launchAgentLabel: flags.launchAgentLabel,
    piPath: flags.piPath,
    codexPath: flags.codexPath,
    claudePath: flags.claudePath,
  };
}
