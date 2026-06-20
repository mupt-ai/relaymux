const EXECUTOR_ALIASES = new Map([
  ["tmux", "local-tmux"],
  ["local", "local-tmux"],
  ["local-tmux", "local-tmux"],
  ["local-tmux-window", "local-tmux"],
  ["background", "local-background"],
  ["bg", "local-background"],
  ["local-bg", "local-background"],
  ["local-background", "local-background"],
  ["cloud", "cloud-sandbox"],
  ["sandbox", "cloud-sandbox"],
  ["cloud-sandbox", "cloud-sandbox"],
]);

export const DEFAULT_EXECUTOR = "local-tmux";

export function normalizeExecutorName(value) {
  const raw = String(value || DEFAULT_EXECUTOR).trim();
  const normalized = EXECUTOR_ALIASES.get(raw.toLowerCase());
  if (!normalized) {
    throw new Error(`Invalid executor "${raw}". Use local-tmux, local-background, or cloud-sandbox.`);
  }
  return normalized;
}

export function resolveExecutorName({ flags = {}, config = {} }: any = {}) {
  return normalizeExecutorName(flags.executor || flags.mode || config.execution?.defaultExecutor || DEFAULT_EXECUTOR);
}

export function resolveExecutionGroup({ flags = {}, executor, sessionInfo = null }: any = {}) {
  if (flags.group) return String(flags.group);
  if (executor === "local-tmux" && sessionInfo?.session) return sessionInfo.session;
  if (flags.session) return String(flags.session);
  return "";
}

export function executorChoicesText() {
  return "local-tmux, local-background, or cloud-sandbox";
}

