import fs from "node:fs";

import { getIntegration, isIntegrationEnabled } from "./config.js";
import { expandPath } from "./paths.js";
import { normalizeMessages, splitMessage } from "./message-io.js";

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

export function isTelegramReceiveEnabled(config) {
  const telegram = getIntegration(config, "telegram");
  const receive = telegram.receive || {};
  return telegram.enabled === true && receive.enabled === true;
}

export async function receiveTelegramMessages(config, state: any = {}, env = process.env) {
  if (!isTelegramReceiveEnabled(config)) return [];
  const telegram = getIntegration(config, "telegram");
  const chatId = String(telegram.chatId || "").trim();
  if (!chatId || chatId === "TELEGRAM_CHAT_ID") {
    throw new Error("Telegram receive requires config.integrations.telegram.chatId");
  }

  const { token, source } = resolveTelegramToken(config, env);
  if (!token) {
    throw new Error(`Telegram adapter token is missing (${source})`);
  }

  const updates = await getTelegramUpdates(telegram, token, state.lastTelegramUpdateId);
  let maxUpdateId = Number(state.lastTelegramUpdateId || 0);
  const messages: any[] = [];

  for (const update of updates) {
    const updateId = Number(update.update_id);
    if (Number.isFinite(updateId) && updateId > maxUpdateId) maxUpdateId = updateId;
    const message = update.message || update.edited_message;
    if (!message || String(message.chat?.id || "") !== chatId) continue;
    if (message.from?.is_bot) continue;
    const text = String(message.text || message.caption || "");
    const attachments = collectTelegramAttachments(message);
    messages.push({
      id: `telegram-${message.message_id || update.update_id}`,
      text,
      date: message.date ? new Date(Number(message.date) * 1000).toISOString() : "",
      sender: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || String(message.from?.id || ""),
      isFromMe: false,
      attachments,
      raw: message,
    });
  }

  if (maxUpdateId) state.lastTelegramUpdateId = maxUpdateId;
  return normalizeMessages(messages);
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

async function getTelegramUpdates(telegram, token, offsetUpdateId) {
  const apiBaseUrl = String(telegram.apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "");
  const receive = telegram.receive || {};
  const timeoutMs = Number(receive.timeoutMs || telegram.timeoutMs || 30000);
  const limit = Math.max(1, Math.min(Number(receive.syncLimit || 20), 100));
  const params = new URLSearchParams({ limit: String(limit), timeout: "0", allowed_updates: JSON.stringify(["message", "edited_message"]) });
  const offset = Number(offsetUpdateId || 0);
  if (Number.isFinite(offset) && offset > 0) params.set("offset", String(offset + 1));
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(`${apiBaseUrl}/bot${token}/getUpdates?${params.toString()}`, { signal: controller?.signal });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    }
    const body = JSON.parse(responseText || "{}");
    if (!body.ok || !Array.isArray(body.result)) {
      throw new Error(`Telegram getUpdates returned an unexpected response: ${responseText.slice(0, 500)}`);
    }
    return body.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Telegram getUpdates timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function collectTelegramAttachments(message) {
  const attachments: any[] = [];
  for (const key of ["photo", "document", "audio", "voice", "video", "video_note", "sticker", "animation"]) {
    if (message[key]) attachments.push({ type: key, value: message[key] });
  }
  return attachments;
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
