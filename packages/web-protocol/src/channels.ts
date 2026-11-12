export const COMMAND_CHANNEL = "dzajcarz:web:command";
export const EVENT_CHANNEL = "dzajcarz:web:event";

const REPLY_PREFIX = "dzajcarz:web:reply:";

/** What a reply channel looks like. The bot publishes only to channels that match, whatever a command says. */
export const REPLY_CHANNEL_PATTERN = /^dzajcarz:web:reply:[0-9a-f-]{36}$/;

/** The channel one web instance listens on for the replies to its own commands. */
export function replyChannel(instanceId: string): string {
  const channel = `${REPLY_PREFIX}${instanceId}`;
  if (!REPLY_CHANNEL_PATTERN.test(channel)) {
    throw new Error(`instanceId must be a UUID, got "${instanceId}"`);
  }
  return channel;
}
