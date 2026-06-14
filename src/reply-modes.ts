export const REPLY_MODES = ["imessage", "telegram", "none"];

export function isReplyMode(value) {
  return REPLY_MODES.includes(String(value));
}

export function replyModesText() {
  return "imessage, telegram, or none";
}
