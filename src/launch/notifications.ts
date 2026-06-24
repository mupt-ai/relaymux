import { isReplyMode, replyModesText } from "../reply-modes.js";

export function resolveLaunchNotification(flags, config) {
  const configured = config.launchNotifications || {};
  const onExit = String(flags.notifyOnExit ?? configured.onExit ?? configured.notifyOnExit ?? "never");
  const replyMode = String(flags.notifyReplyMode ?? configured.replyMode ?? "imessage");
  const tailLines = normalizePositiveInteger(flags.notifyTailLines ?? configured.tailLines, 80);
  const tailBytes = normalizePositiveInteger(flags.notifyTailBytes ?? configured.tailBytes, 4000);

  if (!["never", "failure", "always"].includes(onExit)) {
    throw new Error("--notify-on-exit / launchNotifications.onExit must be never, failure, or always");
  }
  if (!isReplyMode(replyMode)) {
    throw new Error(`--notify-reply-mode / launchNotifications.replyMode must be ${replyModesText()}`);
  }

  return { onExit, replyMode, tailLines, tailBytes };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

