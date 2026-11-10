import { describe, expect, test } from "bun:test";
import {
  BOT_TARGET,
  checkHierarchy,
  HIGHER_THAN_ACTOR,
  HIGHER_THAN_BOT,
  type MemberInfo,
  OWNER_TARGET,
  SELF_TARGET,
} from "./hierarchy.ts";

function member(id: string, topRole: number, extra: Partial<MemberInfo> = {}): MemberInfo {
  return { id, topRole, isOwner: false, permissions: 0n, timedOut: false, ...extra };
}

const actor = member("1", 10);
const bot = member("2", 20);

const check = (target: MemberInfo | null, targetId = target?.id ?? "9", who = actor) =>
  checkHierarchy({ actor: who, bot, targetId, target });

describe("checkHierarchy", () => {
  test("a member with a lower role than both the caller and the bot may be moderated", () => {
    expect(check(member("3", 5))).toBeNull();
  });

  test("nobody moderates themselves", () => {
    expect(check(member("1", 10))).toBe(SELF_TARGET);
  });

  test("the bot does not moderate itself", () => {
    expect(check(bot)).toBe(BOT_TARGET);
  });

  test("the owner cannot be moderated, even by someone with a higher role", () => {
    const owner = member("3", 0, { isOwner: true });
    expect(check(owner, "3", member("1", 99))).toBe(OWNER_TARGET);
  });

  test("an equal role is refused, like a higher one", () => {
    expect(check(member("3", 10))).toBe(HIGHER_THAN_ACTOR);
    expect(check(member("3", 15))).toBe(HIGHER_THAN_ACTOR);
  });

  test("the owner as caller is not limited by roles, but the bot's role still is", () => {
    const owner = member("1", 0, { isOwner: true });
    expect(check(member("3", 15), "3", owner)).toBeNull();
    expect(check(member("3", 20), "3", owner)).toBe(HIGHER_THAN_BOT);
  });

  test("a target at or above the bot's role is refused even when the caller ranks higher", () => {
    const strong = member("1", 50);
    expect(check(member("3", 20), "3", strong)).toBe(HIGHER_THAN_BOT);
    expect(check(member("3", 30), "3", strong)).toBe(HIGHER_THAN_BOT);
  });

  test("when the bot does not act, its role position is not checked, the other rules still are", () => {
    const above = (target: MemberInfo, who = actor) =>
      checkHierarchy({ actor: who, bot, targetId: target.id, target, botActs: false });
    expect(above(member("3", 5))).toBeNull();
    const owner = member("1", 0, { isOwner: true });
    expect(above(member("3", 25), owner)).toBeNull();
    expect(above(member("3", 25))).toBe(HIGHER_THAN_ACTOR);
    expect(above(member("3", 0, { isOwner: true }))).toBe(OWNER_TARGET);
    expect(above(bot)).toBe(BOT_TARGET);
    expect(above(member("1", 10))).toBe(SELF_TARGET);
  });

  test("a non-member is checked by id only", () => {
    expect(check(null, "3")).toBeNull();
    expect(check(null, actor.id)).toBe(SELF_TARGET);
    expect(check(null, bot.id)).toBe(BOT_TARGET);
  });

  test("the caller rule wins over the bot rule, so the caller learns about their own limit first", () => {
    expect(check(member("3", 25))).toBe(HIGHER_THAN_ACTOR);
  });
});
