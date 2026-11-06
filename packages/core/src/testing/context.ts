import type { CommandContext, Invocation, Reply } from "../command.ts";

export interface FakeContext<A> extends CommandContext<A> {
  /** Every reply, in order. */
  readonly replies: Reply[];
  deferred: boolean;
}

export interface FakeContextOptions<A> {
  args?: A;
  invocation?: Invocation;
  subcommand?: string;
  guildId?: string | null;
  memberPermissions?: bigint | null;
  userId?: string;
}

/** An in-memory CommandContext for testing commands without Discord. */
export function createFakeContext<A = Record<string, unknown>>({
  args = {} as A,
  invocation = "slash",
  subcommand,
  guildId = "100000000000000001",
  memberPermissions = 0n,
  userId = "200000000000000002",
}: FakeContextOptions<A> = {}): FakeContext<A> {
  const ctx: FakeContext<A> = {
    args,
    invocation,
    subcommand,
    guildId,
    channelId: "300000000000000003",
    memberPermissions: guildId === null ? null : memberPermissions,
    user: { id: userId, displayName: "tester" },
    replies: [],
    deferred: false,
    async reply(reply) {
      ctx.replies.push(reply);
    },
    async defer() {
      ctx.deferred = true;
    },
  };
  return ctx;
}

/** The text of a reply, whether it was a string or an object. */
export function replyText(reply: Reply | undefined): string | undefined {
  return typeof reply === "string" ? reply : reply?.content;
}
