import { type Client, type MessageCreateOptions, RESTJSONErrorCodes } from "discord.js";
import { hasCode } from "./errors.ts";
import { NO_MENTIONS } from "./reply.ts";

/** Sends a DM; false when the user has DMs closed, any other failure is rethrown. */
export async function sendDirectMessage(
  client: Client,
  userId: string,
  payload: Omit<MessageCreateOptions, "allowedMentions">,
): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ ...payload, allowedMentions: NO_MENTIONS });
    return true;
  } catch (error) {
    if (hasCode(error, RESTJSONErrorCodes.CannotSendMessagesToThisUser)) return false;
    throw error;
  }
}
