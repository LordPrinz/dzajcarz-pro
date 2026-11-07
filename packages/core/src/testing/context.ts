import type { CommandContext, Invocation, Reply } from "../command.ts";
import { type ComponentContext, validateRows } from "../component.ts";
import { executeComponent, UNKNOWN_COMPONENT } from "../dispatch.ts";
import { silentLogger } from "../logger.ts";
import type { CommandRegistry } from "../registry.ts";

export interface FakeContext<A> extends CommandContext<A> {
  /** Every reply, in order. */
  readonly replies: Reply[];
  deferred: boolean;
  /** The options of the last defer() call. */
  deferOptions?: { ephemeral?: boolean };
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
      checkComponents(reply);
      ctx.replies.push(reply);
    },
    async defer(options) {
      ctx.deferred = true;
      ctx.deferOptions = options;
    },
  };
  return ctx;
}

function checkComponents(reply: Reply): void {
  if (typeof reply !== "string" && reply.components) validateRows(reply.components);
}

export interface FakeComponentContext extends ComponentContext {
  /** Every `update()`, in order. */
  readonly updates: Reply[];
  /** Every `reply()`, in order. */
  readonly replies: Reply[];
}

export interface FakeComponentContextOptions {
  state?: string;
  values?: readonly string[];
  guildId?: string | null;
  memberPermissions?: bigint | null;
  userId?: string;
}

/** An in-memory ComponentContext for calling a button or select handler directly. */
export function createFakeComponentContext({
  state = "",
  values = [],
  guildId = "100000000000000001",
  memberPermissions = 0n,
  userId = "200000000000000002",
}: FakeComponentContextOptions = {}): FakeComponentContext {
  const ctx: FakeComponentContext = {
    state,
    values,
    guildId,
    channelId: "300000000000000003",
    memberPermissions: guildId === null ? null : memberPermissions,
    user: { id: userId, displayName: "tester" },
    updates: [],
    replies: [],
    async update(reply) {
      checkComponents(reply);
      ctx.updates.push(reply);
    },
    async reply(reply) {
      checkComponents(reply);
      ctx.replies.push(reply);
    },
  };
  return ctx;
}

export interface ClickOptions extends Omit<FakeComponentContextOptions, "state"> {
  registry: CommandRegistry;
  /** The `customId` of the clicked button or select, as the module put it in its reply. */
  customId: string;
}

/**
 * Plays a click through the same routing and checks as the bot (custom_id lookup, owner, permissions,
 * error policy) without Discord. The clicking user defaults to a different member than the owner only
 * if you pass `userId`; otherwise it is the owner named in the custom_id.
 */
export async function clickComponent({
  registry,
  customId,
  ...options
}: ClickOptions): Promise<FakeComponentContext> {
  const resolved = registry.resolveComponent(customId);
  const ctx = createFakeComponentContext({
    userId: resolved?.owner,
    ...options,
    state: resolved?.state,
  });
  if (!resolved) {
    await ctx.reply({ content: UNKNOWN_COMPONENT, ephemeral: true });
    return ctx;
  }
  await executeComponent(resolved, ctx, silentLogger);
  return ctx;
}

/** The text of a reply, whether it was a string or an object. */
export function replyText(reply: Reply | undefined): string | undefined {
  return typeof reply === "string" ? reply : reply?.content;
}
