export const RELAYMUX_CLOUD_AGENT_PROTOCOL = "relaymux-cloud-agent-v1";
export const RELAYMUX_SANDBOX_HANDS_PROTOCOL = "relaymux-sandbox-hands-v1";

export const RELAYMUX_CLOUD_AGENT_ENV = {
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  telegramWebhookSecret: "RELAYMUX_TELEGRAM_WEBHOOK_SECRET",
  sandboxBaseUrl: "RELAYMUX_SANDBOX_BASE_URL",
  sandboxAuthToken: "RELAYMUX_SANDBOX_TOKEN",
  cloudCallbackToken: "RELAYMUX_CLOUD_CALLBACK_TOKEN",
};

export const SANDBOX_HAND_OPERATIONS = new Set(["ask", "launch", "notify"]);

export type SandboxHandOperation = "ask" | "launch" | "notify";
export type SandboxReplyMode = "none" | "imessage" | "telegram";
export type CloudMetadata = Record<string, unknown>;

export type SandboxCallback = {
  url: string;
  authTokenEnv?: string;
};

export type SandboxAskRequestInput = {
  text?: string;
  message?: string;
  source?: string;
  replyMode?: SandboxReplyMode;
  wait?: boolean;
  idempotencyKey?: string;
  metadata?: CloudMetadata;
  callback?: SandboxCallback;
};

export type SandboxLaunchRequestInput = {
  repo?: string;
  agent?: string;
  name?: string;
  prompt?: string;
  text?: string;
  message?: string;
  idempotencyKey?: string;
  metadata?: CloudMetadata;
  notify?: {
    callback?: SandboxCallback;
    idempotencyKey?: string;
    replyMode?: SandboxReplyMode;
  };
};

export type SandboxNotifyRequestInput = {
  from?: string;
  source?: string;
  text?: string;
  message?: string;
  idempotencyKey?: string;
  metadata?: CloudMetadata;
};

export function buildSandboxAskRequest(input: SandboxAskRequestInput = {}) {
  const text = requireNonEmptyString(input.text ?? input.message, "text");
  return {
    protocol: RELAYMUX_SANDBOX_HANDS_PROTOCOL,
    operation: "ask",
    text,
    source: normalizeSource(input.source),
    replyMode: normalizeReplyMode(input.replyMode),
    wait: input.wait !== false,
    idempotencyKey: normalizeOptionalString(input.idempotencyKey),
    metadata: normalizeMetadata(input.metadata),
    callback: normalizeCallback(input.callback),
  };
}

export function buildSandboxLaunchRequest(input: SandboxLaunchRequestInput = {}) {
  return {
    protocol: RELAYMUX_SANDBOX_HANDS_PROTOCOL,
    operation: "launch",
    repo: requireNonEmptyString(input.repo, "repo"),
    agent: requireNonEmptyString(input.agent, "agent"),
    name: normalizeOptionalString(input.name),
    prompt: requireNonEmptyString(input.prompt ?? input.text ?? input.message, "prompt"),
    idempotencyKey: normalizeOptionalString(input.idempotencyKey),
    metadata: normalizeMetadata(input.metadata),
    notify: normalizeNotify(input.notify),
  };
}

export function buildSandboxNotifyRequest(input: SandboxNotifyRequestInput = {}) {
  return {
    protocol: RELAYMUX_SANDBOX_HANDS_PROTOCOL,
    operation: "notify",
    from: requireNonEmptyString(input.from ?? input.source, "from"),
    text: requireNonEmptyString(input.text ?? input.message, "text"),
    idempotencyKey: normalizeOptionalString(input.idempotencyKey),
    metadata: normalizeMetadata(input.metadata),
  };
}

export function normalizeSandboxEnvelope(body: unknown, expectedOperation?: SandboxHandOperation) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("sandbox hand request must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const protocol = String(raw.protocol || "");
  if (protocol !== RELAYMUX_SANDBOX_HANDS_PROTOCOL) {
    throw new Error(`sandbox hand protocol must be ${RELAYMUX_SANDBOX_HANDS_PROTOCOL}`);
  }

  const operation = String(raw.operation || "");
  if (!isSandboxHandOperation(operation)) {
    throw new Error("sandbox hand operation must be ask, launch, or notify");
  }
  if (expectedOperation && operation !== expectedOperation) {
    throw new Error(`sandbox hand operation must be ${expectedOperation}`);
  }

  return { ...raw, protocol, operation };
}

function normalizeSource(value: string | undefined) {
  return String(value || "relaymux-cloud-agent").slice(0, 200);
}

function normalizeReplyMode(value: SandboxReplyMode | undefined) {
  const replyMode = String(value || "none");
  if (!["none", "imessage", "telegram"].includes(replyMode)) {
    throw new Error("replyMode must be none, imessage, or telegram");
  }
  return replyMode as SandboxReplyMode;
}

function normalizeMetadata(value: CloudMetadata | undefined) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be a JSON object");
  }
  return value;
}

function normalizeCallback(value: SandboxCallback | undefined) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("callback must be a JSON object");
  }
  const url = requireNonEmptyString(value.url, "callback.url");
  return {
    url,
    authTokenEnv: normalizeOptionalString(value.authTokenEnv) || RELAYMUX_CLOUD_AGENT_ENV.cloudCallbackToken,
  };
}

function normalizeNotify(value: SandboxLaunchRequestInput["notify"] | undefined) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("notify must be a JSON object");
  }
  return {
    callback: value.callback ? normalizeCallback(value.callback) : undefined,
    idempotencyKey: normalizeOptionalString(value.idempotencyKey),
    replyMode: normalizeReplyMode(value.replyMode),
  };
}

function requireNonEmptyString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function normalizeOptionalString(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function isSandboxHandOperation(value: string): value is SandboxHandOperation {
  return SANDBOX_HAND_OPERATIONS.has(value);
}
