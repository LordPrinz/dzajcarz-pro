import { RESTJSONErrorCodes } from "discord.js";

/** Whether `error` is a Discord API error with one of `codes` (RESTJSONErrorCodes). */
export function hasCode(error: unknown, ...codes: number[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number" &&
    codes.includes(error.code)
  );
}

/** Codes that mean the thing is not reachable for the bot; anything else (rate limit, 5xx) is not an answer. */
const GONE_CODES = [
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownGuild,
  RESTJSONErrorCodes.UnknownMember,
  RESTJSONErrorCodes.MissingAccess,
];

/** The fetched value, or null when it is gone or forbidden; any other failure is rethrown. */
export async function fetchOrNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (hasCode(error, ...GONE_CODES)) return null;
    throw error;
  }
}
