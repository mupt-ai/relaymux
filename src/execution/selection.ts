export const DEFAULT_EXECUTOR = "local-tmux";

const EXECUTORS = new Set([
  "local-tmux",
  "local-background",
  "cloud-sandbox",
]);

export function normalizeExecutorName(value) {
  const raw = String(value || DEFAULT_EXECUTOR).trim();
  if (!EXECUTORS.has(raw)) {
    throw new Error(`Invalid executor "${raw}". Use local-tmux, local-background, or cloud-sandbox.`);
  }
  return raw;
}

export function resolveExecutorName({ flags = {}, config = {} }: any = {}) {
  return normalizeExecutorName(flags.executor || config.execution?.defaultExecutor || DEFAULT_EXECUTOR);
}

export function resolveExecutionGroup({ flags = {}, executor, sessionInfo = null }: any = {}) {
  if (flags.group) return String(flags.group);
  if (executor === "local-tmux" && sessionInfo?.session) return sessionInfo.session;
  if (flags.session) return String(flags.session);
  return "";
}

