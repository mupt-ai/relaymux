import fs from "node:fs";
import path from "node:path";

import {
  RELAYMUX_CLOUD_AGENT_ENV,
  RELAYMUX_CLOUD_AGENT_PROTOCOL,
  RELAYMUX_SANDBOX_HANDS_PROTOCOL,
} from "./cloud-protocol.js";
import { ensureDirectory, expandPath } from "./paths.js";

export type CloudScaffoldOptions = {
  outDir?: string;
  force?: boolean;
  flue?: boolean;
};

type CloudScaffoldFile = {
  path: string;
  content: string;
  mode?: number;
};

export function scaffoldCloudAgent({ outDir, force = false, flue = false }: CloudScaffoldOptions = {}) {
  if (!flue) {
    throw new Error("cloud scaffold currently supports only --flue");
  }
  if (!outDir) {
    throw new Error("Missing --out <dir>");
  }

  const root = expandPath(String(outDir));
  const files = cloudScaffoldFiles();
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !force) {
    throw new Error(`Output directory is not empty: ${root}. Use --force to overwrite generated files.`);
  }

  ensureDirectory(root);
  const written: string[] = [];
  for (const file of files) {
    const target = path.join(root, file.path);
    if (fs.existsSync(target) && !force) {
      throw new Error(`Refusing to overwrite ${target}. Use --force.`);
    }
    ensureDirectory(path.dirname(target));
    fs.writeFileSync(target, file.content, { mode: file.mode || 0o644 });
    written.push(target);
  }

  return { root, files: written };
}

export function cloudScaffoldFiles(): CloudScaffoldFile[] {
  return [
    { path: "README.md", content: renderBundleReadme() },
    { path: "package.json", content: renderPackageJson() },
    { path: "flue.yml", content: renderFlueYaml() },
    { path: "src/cloud-agent.mjs", content: renderCloudAgent() },
  ];
}

function renderPackageJson() {
  return `${JSON.stringify({
    name: "relaymux-flue-cloud-agent",
    private: true,
    type: "module",
    scripts: {
      start: "node src/cloud-agent.mjs",
      check: "node --check src/cloud-agent.mjs",
    },
    engines: {
      node: ">=20",
    },
  }, null, 2)}\n`;
}

function renderFlueYaml() {
  return [
    "schema_version: 1",
    "name: relaymux-cloud-agent",
    "runtime:",
    "  command: npm start",
    "  port: 8787",
    "  health_path: /health",
    "env:",
    `  ${RELAYMUX_CLOUD_AGENT_ENV.telegramBotToken}: \${${RELAYMUX_CLOUD_AGENT_ENV.telegramBotToken}}`,
    `  ${RELAYMUX_CLOUD_AGENT_ENV.telegramWebhookSecret}: \${${RELAYMUX_CLOUD_AGENT_ENV.telegramWebhookSecret}}`,
    `  ${RELAYMUX_CLOUD_AGENT_ENV.sandboxBaseUrl}: \${${RELAYMUX_CLOUD_AGENT_ENV.sandboxBaseUrl}}`,
    `  ${RELAYMUX_CLOUD_AGENT_ENV.sandboxAuthToken}: \${${RELAYMUX_CLOUD_AGENT_ENV.sandboxAuthToken}}`,
    `  ${RELAYMUX_CLOUD_AGENT_ENV.cloudCallbackToken}: \${${RELAYMUX_CLOUD_AGENT_ENV.cloudCallbackToken}}`,
    "",
  ].join("\n");
}

function renderBundleReadme() {
  return [
    "# relaymux Flue cloud agent scaffold",
    "",
    "This bundle is a starting point for the optional cloud-agent topology:",
    "",
    "```text",
    "Telegram -> Flue cloud agent -> authenticated sandbox hands -> relaymux/tmux",
    "                                 sandbox completion callback -> Telegram",
    "```",
    "",
    "It is intentionally small. It does not deploy relaymux or expose command execution by itself; it only receives Telegram webhook payloads and calls a sandbox hands endpoint that must enforce its own auth and isolation.",
    "",
    "## Environment",
    "",
    "| Name | Purpose |",
    "| --- | --- |",
    `| \`${RELAYMUX_CLOUD_AGENT_ENV.telegramBotToken}\` | Telegram Bot API token in the cloud runtime. |`,
    `| \`${RELAYMUX_CLOUD_AGENT_ENV.telegramWebhookSecret}\` | Optional Telegram webhook secret checked against \`X-Telegram-Bot-Api-Secret-Token\`. |`,
    `| \`${RELAYMUX_CLOUD_AGENT_ENV.sandboxBaseUrl}\` | HTTPS base URL for the sandbox hands service. |`,
    `| \`${RELAYMUX_CLOUD_AGENT_ENV.sandboxAuthToken}\` | Bearer token used when the cloud agent calls sandbox hands. |`,
    `| \`${RELAYMUX_CLOUD_AGENT_ENV.cloudCallbackToken}\` | Optional bearer token required on sandbox completion callbacks. |`,
    "",
    "Do not put literal tokens in `flue.yml`; keep the placeholders wired to the Flue environment/secret store.",
    "",
    "## Endpoints",
    "",
    "- `GET /health`: cloud-agent health check.",
    "- `POST /telegram`: Telegram webhook receiver. Configure Telegram to send updates here.",
    "- `POST /relaymux/v1/completion`: callback target for sandbox hands to send final updates back to Telegram.",
    "",
    "The cloud agent calls `POST <RELAYMUX_SANDBOX_BASE_URL>/relaymux/v1/ask` with `Authorization: Bearer <RELAYMUX_SANDBOX_TOKEN>` and protocol `relaymux-sandbox-hands-v1`.",
    "",
    "Run locally for smoke checks:",
    "",
    "```bash",
    "npm install",
    "npm run check",
    "npm start",
    "```",
    "",
  ].join("\n");
}

function renderCloudAgent() {
  return `import http from "node:http";

const CLOUD_PROTOCOL = ${JSON.stringify(RELAYMUX_CLOUD_AGENT_PROTOCOL)};
const SANDBOX_PROTOCOL = ${JSON.stringify(RELAYMUX_SANDBOX_HANDS_PROTOCOL)};
const PORT = Number(process.env.PORT || process.env.RELAYMUX_CLOUD_AGENT_PORT || 8787);
const TELEGRAM_TOKEN = process.env.${RELAYMUX_CLOUD_AGENT_ENV.telegramBotToken} || "";
const TELEGRAM_WEBHOOK_SECRET = process.env.${RELAYMUX_CLOUD_AGENT_ENV.telegramWebhookSecret} || "";
const SANDBOX_BASE_URL = process.env.${RELAYMUX_CLOUD_AGENT_ENV.sandboxBaseUrl} || "";
const SANDBOX_TOKEN = process.env.${RELAYMUX_CLOUD_AGENT_ENV.sandboxAuthToken} || "";
const CALLBACK_TOKEN = process.env.${RELAYMUX_CLOUD_AGENT_ENV.cloudCallbackToken} || "";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://relaymux-cloud-agent.local");
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true, protocol: CLOUD_PROTOCOL, sandboxProtocol: SANDBOX_PROTOCOL });
      return;
    }

    if (req.method === "POST" && url.pathname === "/telegram") {
      if (!telegramWebhookAuthorized(req)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      await handleTelegram(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/relaymux/v1/completion") {
      if (!callbackAuthorized(req)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      await handleCompletion(req, res);
      return;
    }

    writeJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("relaymux Flue cloud agent listening on port " + PORT);
});

async function handleTelegram(req, res) {
  assertConfigured();
  const update = await readJson(req);
  const message = update.message || update.edited_message;
  const text = String(message?.text || message?.caption || "").trim();
  const chatId = message?.chat?.id;
  const messageId = message?.message_id || update.update_id || Date.now();
  if (!chatId || !text || message?.from?.is_bot) {
    writeJson(res, 200, { ok: true, ignored: true });
    return;
  }

  const sandboxResult = await postSandbox("/relaymux/v1/ask", {
    protocol: SANDBOX_PROTOCOL,
    operation: "ask",
    source: "telegram",
    text,
    replyMode: "none",
    wait: true,
    idempotencyKey: "telegram:" + chatId + ":" + messageId,
    metadata: {
      telegram: {
        chatId: String(chatId),
        messageId: String(messageId),
        updateId: update.update_id === undefined ? "" : String(update.update_id),
      },
    },
  });

  const reply = String(sandboxResult.reply || (sandboxResult.queued ? "Queued in sandbox." : "Sandbox accepted the request."));
  await sendTelegramMessage(chatId, reply);
  writeJson(res, 200, { ok: true });
}

async function handleCompletion(req, res) {
  const body = await readJson(req);
  const text = String(body.text || body.message || "").trim();
  const chatId = body.chatId || body.metadata?.telegram?.chatId;
  if (!text) throw new Error("completion text is required");
  if (!chatId) throw new Error("completion metadata.telegram.chatId is required");
  await sendTelegramMessage(chatId, text);
  writeJson(res, 200, { ok: true });
}

async function postSandbox(path, body) {
  const url = SANDBOX_BASE_URL.replace(/\\/+$/, "") + path;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + SANDBOX_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error("sandbox returned HTTP " + response.status + ": " + text.slice(0, 500));
  return payload;
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) }),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error("Telegram sendMessage failed with HTTP " + response.status + ": " + responseText.slice(0, 500));
}

function assertConfigured() {
  if (!SANDBOX_BASE_URL) throw new Error("RELAYMUX_SANDBOX_BASE_URL is required");
  if (!SANDBOX_TOKEN) throw new Error("RELAYMUX_SANDBOX_TOKEN is required");
}

function telegramWebhookAuthorized(req) {
  if (!TELEGRAM_WEBHOOK_SECRET) return true;
  return String(req.headers["x-telegram-bot-api-secret-token"] || "") === TELEGRAM_WEBHOOK_SECRET;
}

function callbackAuthorized(req) {
  if (!CALLBACK_TOKEN) return true;
  return String(req.headers.authorization || "") === "Bearer " + CALLBACK_TOKEN;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) throw new Error("JSON body is required");
  return JSON.parse(raw);
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}
`;
}
