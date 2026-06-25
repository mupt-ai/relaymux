export const DEFAULT_EXECUTOR = "local-tmux";

export function normalizeExecutorName(value) {
  const raw = String(value || DEFAULT_EXECUTOR).trim();
  if (raw !== DEFAULT_EXECUTOR) {
    throw new Error(`Invalid executor "${raw}". relaymux launches agents only in tmux tabs; use local-tmux or omit --executor.`);
  }
  return raw;
}

export function resolveExecutorName({ flags = {}, config = {} }: any = {}) {
  return normalizeExecutorName(flags.executor || DEFAULT_EXECUTOR);
}

export function resolveExecutionGroup({ flags = {}, executor, sessionInfo = null }: any = {}) {
  if (flags.group) return String(flags.group);
  if (sessionInfo?.session) return sessionInfo.session;
  if (flags.session) return String(flags.session);
  return "";
}
