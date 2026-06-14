import fs from "node:fs";

import { getIntegration, isIntegrationEnabled } from "./config.js";
import { expandPath } from "./paths.js";
import { splitMessage } from "./message-io.js";

export function resolveTelegramToken(config, env = process.env) {
  const telegram = getIntegration(config, "telegram");
  const tokenEnv = String(telegram.botTokenEnv || "").trim();
  if (tokenEnv && env[tokenEnv]) {
    return { token: String(env[tokenEnv]).trim(), source: `env:${tokenEnv}` };
  }

  const tokenFile = String(telegram.botTokenFile || "").trim();
  if (tokenFile) {
    const resolved = expandPath(tokenFile);
    const token = fs.readFileSync(resolved, "utf8").trim();
    return { token, source: `file:${resolved}` };
  }

  return { token: "", source: tokenEnv ? `env:${tokenEnv}` : "missing" };
}

export async function sendTelegramMessage(config, text, io: any = process, env = io.env || process.env) {
  const telegram = getIntegration(config, "telegram");
  if (!isIntegrationEnabled(config, "telegram")) {
    throw new Error("Telegram adapter is not enabled in config.integrations.telegram");
  }

  const chatId = String(telegram.chatId || "").trim();
  if (!chatId || chatId === "TELEGRAM_CHAT_ID") {
    throw new Error("Telegram adapter requires config.integrations.telegram.chatId");
  }

  const { token, source } = resolveTelegramToken(config, env);
  if (!token) {
    throw new Error(`Telegram adapter token is missing (${source})`);
  }

  const maxChars = normalizeMaxMessageChars(telegram.maxMessageChars);
  const chunks = splitMessage(text, maxChars);
  for (const chunk of chunks) {
    await postTelegramSendMessage(telegram, token, {
      chat_id: chatId,
      text: chunk,
      ...(telegram.parseMode ? { parse_mode: String(telegram.parseMode) } : {}),
    });
  }
}

async function postTelegramSendMessage(telegram, token, body) {
  const apiBaseUrl = String(telegram.apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "");
  const timeoutMs = Number(telegram.timeoutMs || 30000);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(`${apiBaseUrl}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Telegram send failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Telegram send timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeMaxMessageChars(value) {
  const number = Number(value || 3900);
  if (!Number.isFinite(number) || number < 1) return 3900;
  return Math.min(Math.floor(number), 4096);
}
