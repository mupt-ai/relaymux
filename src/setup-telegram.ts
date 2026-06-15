import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { defaultConfig, defaultTelegramIntegration } from "./config.js";
import { findExecutable } from "./doctor.js";
import { expandPath } from "./paths.js";
import { resolveTelegramToken } from "./telegram.js";

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
    receive: {
      ...defaults.receive,
      enabled: options.telegramReceiveEnabled ?? options.receiveEnabled ?? true,
      pollMs: Number(options.telegramPollMs || options.pollMs || defaults.receive.pollMs),
      syncLimit: Number(options.telegramSyncLimit || options.syncLimit || defaults.receive.syncLimit),
      timeoutMs: Number(options.telegramReceiveTimeoutMs || options.receiveTimeoutMs || defaults.receive.timeoutMs),
    },
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

export async function initTelegramOptionsFromFlags(flags, io: any = process, env = process.env) {
  const tokenFile = await resolveTelegramTokenFile(flags, io, env);
  const chatId = flags.telegramChatId || await resolveTelegramChatId({ ...flags, telegramBotTokenFile: tokenFile }, io, env);
  return {
    telegramChatId: chatId,
    telegramBotTokenEnv: tokenFile ? "" : flags.telegramBotTokenEnv,
    telegramBotTokenFile: tokenFile || flags.telegramBotTokenFile,
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

export async function resolveTelegramTokenFile(flags: any, io: any = process, env = process.env) {
  if (flags.telegramBotTokenFile) return String(flags.telegramBotTokenFile);
  if (flags.telegramBotTokenEnv && env[flags.telegramBotTokenEnv] && !flags.telegramBotToken) return "";

  let token = flags.telegramBotToken || flags.botToken;
  if (!token && env.TELEGRAM_BOT_TOKEN) token = env.TELEGRAM_BOT_TOKEN;
  if (!token && isInteractive(io)) token = await promptSecret(io, "Telegram bot token: ");
  if (!token) return "";

  const tokenFile = expandPath(flags.telegramStoreTokenFile || defaultTelegramTokenFile(env));
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${String(token).trim()}\n`, { mode: 0o600 });
  try { fs.chmodSync(path.dirname(tokenFile), 0o700); } catch {}
  try { fs.chmodSync(tokenFile, 0o600); } catch {}
  io.stdout?.write?.(`Stored Telegram bot token at ${tokenFile}\n`);
  return tokenFile;
}

export async function resolveTelegramChatId(flags: any, io: any = process, env = process.env) {
  if (flags.telegramChatId) return String(flags.telegramChatId);

  const probeConfig = {
    integrations: {
      telegram: buildTelegramIntegration({
        ...flags,
        telegramChatId: "0",
        telegramBotTokenFile: flags.telegramBotTokenFile,
        telegramBotTokenEnv: flags.telegramBotTokenEnv,
        telegramApiBaseUrl: flags.telegramApiBaseUrl,
        telegramTimeoutMs: flags.telegramTimeoutMs,
      }),
    },
  };
  const { token, source } = resolveTelegramToken(probeConfig, env);
  if (!token) throw new Error(`Missing Telegram bot token (${source}). Pass --telegram-bot-token <token> or --telegram-bot-token-file <path>.`);

  const waitMs = Number(flags.telegramChatWaitMs || 60000);
  const pollMs = Number(flags.telegramChatPollMs || 2000);
  io.stdout?.write?.("Open your Telegram bot and send /start. Waiting for the first incoming chat...\n");

  const started = Date.now();
  let lastError: any = null;
  while (Date.now() - started <= waitMs) {
    try {
      const chatId = await discoverTelegramChatId({
        token,
        apiBaseUrl: flags.telegramApiBaseUrl,
        timeoutMs: flags.telegramTimeoutMs,
      });
      if (chatId) return chatId;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }

  const suffix = lastError ? ` Last error: ${lastError.message || String(lastError)}` : "";
  throw new Error(`Could not discover Telegram chat id. Send /start to the bot and re-run with --telegram-chat-id <id>.${suffix}`);
}

export async function discoverTelegramChatId({ token, apiBaseUrl = "https://api.telegram.org", timeoutMs = 30000 }: any) {
  const base = String(apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "");
  const controller = Number(timeoutMs) > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), Number(timeoutMs)) : null;
  try {
    const response = await fetch(`${base}/bot${token}/getUpdates?limit=20&timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "edited_message"]))}`, { signal: controller?.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Telegram getUpdates failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text || "{}");
    if (!body.ok || !Array.isArray(body.result)) throw new Error(`Telegram getUpdates returned an unexpected response: ${text.slice(0, 300)}`);
    const update = body.result.find((item) => {
      const message = item.message || item.edited_message;
      return message?.chat?.id !== undefined && !message.from?.is_bot;
    });
    const chatId = update?.message?.chat?.id ?? update?.edited_message?.chat?.id;
    return chatId === undefined ? "" : String(chatId);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function defaultTelegramTokenFile(env = process.env) {
  return path.join(env.HOME || os.homedir(), ".relaymux", "secrets", "telegram-bot-token");
}

async function promptSecret(io, prompt) {
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function isInteractive(io) {
  return Boolean(io.stdin?.isTTY && io.stdout?.isTTY);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
