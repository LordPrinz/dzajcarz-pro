import type { Locale } from "@dzajcarz/core";
import { t } from "./messages.ts";

/** What the moderation rules need to know about a member of the guild. */
export interface MemberInfo {
  id: string;
  isOwner: boolean;
  /** Position of the member's highest role; 0 is @everyone. */
  topRole: number;
  /** Guild-level permission bits (roles only, no channel overwrites). */
  permissions: bigint;
  /** Whether a timeout is running for the member right now. */
  timedOut: boolean;
}

/**
 * Discord's own rule for moderating someone, checked before the bot asks Discord, so the caller gets a
 * clear reason instead of a "missing permissions" error. `target` is null for a user who is not a member
 * (only a ban can reach them): they hold no roles, so only the id rules apply. Returns the refusal as a text
 * for the caller's language, or null when the action may go ahead.
 */
export function checkHierarchy({
  actor,
  bot,
  targetId,
  target,
  botActs = true,
}: {
  actor: MemberInfo;
  bot: MemberInfo;
  targetId: string;
  target: MemberInfo | null;
  /** False when only the caller acts (a warning): the bot's own role position then does not matter. */
  botActs?: boolean;
}): ((locale: Locale) => string) | null {
  if (targetId === actor.id) return (l) => t(l).selfTarget;
  if (targetId === bot.id) return (l) => t(l).botTarget;
  if (!target) return null;
  if (target.isOwner) return (l) => t(l).ownerTarget;
  if (!actor.isOwner && target.topRole >= actor.topRole) return (l) => t(l).higherThanActor;
  if (botActs && target.topRole >= bot.topRole) return (l) => t(l).higherThanBot;
  return null;
}
