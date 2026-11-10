/**
 * A failure the caller caused or can fix ("join a voice channel first"). Its message is shown to them
 * as is, so write it in the bot's language (Polish) and keep internals out. Any other error is logged
 * and the caller sees a generic message.
 */
export class UserError extends Error {
  override readonly name = "UserError";
}
