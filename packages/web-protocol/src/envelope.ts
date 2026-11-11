import { z } from "zod";
import { REPLY_CHANNEL_PATTERN } from "./channels.ts";

/** The longest a command may stay valid: no deadline lies further than this after `sentAt` or after now. */
export const MAX_COMMAND_TTL_MS = 30_000;

/** Larger raw messages are dropped before `JSON.parse`. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Whether a raw pub/sub message is small enough to parse. */
export const withinMessageLimit = (raw: string): boolean =>
  raw.length <= MAX_MESSAGE_BYTES && Buffer.byteLength(raw) <= MAX_MESSAGE_BYTES;

/** Sent by the web to the bot. `deadline` (epoch ms) is `sentAt` plus the web's timeout. */
export const CommandEnvelope = z
  .object({
    v: z.literal(1),
    id: z.uuid(),
    replyTo: z.string().regex(REPLY_CHANNEL_PATTERN),
    command: z
      .string()
      .max(64)
      .regex(/^[a-z]+(\.[a-z_]+)+$/),
    payload: z.unknown(),
    sentAt: z.number().int(),
    deadline: z.number().int(),
  })
  .refine(
    ({ sentAt, deadline }) => deadline >= sentAt && deadline - sentAt <= MAX_COMMAND_TTL_MS,
    "the deadline must lie within 30 s after sentAt",
  );
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export const ERROR_CODES = ["invalid", "unknown_command", "failed"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The bot's answer to one command. */
export const ReplyEnvelope = z.discriminatedUnion("ok", [
  z.object({ v: z.literal(1), id: z.uuid(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    v: z.literal(1),
    id: z.uuid(),
    ok: z.literal(false),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }),
  }),
]);
export type ReplyEnvelope = z.infer<typeof ReplyEnvelope>;

/** Published by the bot, fire and forget. */
export const EventEnvelope = z.object({
  v: z.literal(1),
  event: z.string().min(1),
  payload: z.unknown(),
  at: z.number().int(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
