import type { CommandContext, CommandPlace, Invocation, Reply } from "../command.ts";
import { type ComponentContext, validateRows } from "../component.ts";
import { executeComponent, executeModal, UNKNOWN_COMPONENT, UNKNOWN_MODAL } from "../dispatch.ts";
import { silentLogger } from "../logger.ts";
import {
  type ModalBaseContext,
  type ModalRawValues,
  type ModalSpec,
  validateModal,
} from "../modal.ts";
import type { CommandRegistry } from "../registry.ts";
import type { Scheduler } from "../scheduler.ts";

export interface FakeContext<A> extends CommandContext<A> {
  /** Every reply, in order. */
  readonly replies: Reply[];
  deferred: boolean;
  /** The options of the last defer() call. */
  deferOptions?: { ephemeral?: boolean };
  /** Every modal opened with `showModal`, in order. */
  readonly modals: ModalSpec[];
}

export interface FakeContextOptions<A> {
  args?: A;
  invocation?: Invocation;
  subcommand?: string;
  guildId?: string | null;
  /** Defaults to `guild` with a guildId and `bot-dm` without. */
  place?: CommandPlace;
  memberPermissions?: bigint | null;
  userId?: string;
}

/** An in-memory CommandContext for testing commands without Discord. */
export function createFakeContext<A = Record<string, unknown>>({
  args = {} as A,
  invocation = "slash",
  subcommand,
  guildId = "100000000000000001",
  place = guildId === null ? "bot-dm" : "guild",
  memberPermissions = 0n,
  userId = "200000000000000002",
}: FakeContextOptions<A> = {}): FakeContext<A> {
  const ctx: FakeContext<A> = {
    args,
    invocation,
    subcommand,
    guildId,
    place,
    channelId: "300000000000000003",
    memberPermissions: guildId === null ? null : memberPermissions,
    user: { id: userId, displayName: "tester" },
    replies: [],
    modals: [],
    deferred: false,
    canShowModal: invocation === "slash",
    async reply(reply) {
      checkComponents(reply);
      ctx.replies.push(reply);
    },
    async defer(options) {
      ctx.deferred = true;
      ctx.deferOptions = options;
    },
    async showModal(modal) {
      if (!ctx.canShowModal)
        throw new Error("A prefix command cannot open a modal; check ctx.canShowModal");
      if (ctx.deferred || ctx.replies.length > 0 || ctx.modals.length > 0) {
        throw new Error(NOT_FIRST_ANSWER);
      }
      validateModal(modal);
      ctx.modals.push(modal);
    },
  };
  return ctx;
}

const NOT_FIRST_ANSWER =
  "showModal() must be the first answer to the interaction, but it was already deferred, replied to or updated";

export const NO_MODAL_UPDATE = "update() works only on a modal opened from a message component";

function checkComponents(reply: Reply): void {
  if (typeof reply !== "string" && reply.components) validateRows(reply.components);
}

export interface FakeComponentContext extends ComponentContext {
  /** Every `update()`, in order. */
  readonly updates: Reply[];
  /** True after `defer()`, explicit or by `executeComponent` when the handler said nothing. */
  deferred: boolean;
  /** Every `reply()`, in order. */
  readonly replies: Reply[];
  /** Every modal opened with `showModal`, in order. */
  readonly modals: ModalSpec[];
}

export interface FakeComponentContextOptions {
  state?: string;
  values?: readonly string[];
  guildId?: string | null;
  /** Defaults to `guild` with a guildId and `bot-dm` without. */
  place?: CommandPlace;
  memberPermissions?: bigint | null;
  userId?: string;
}

/** An in-memory ComponentContext for calling a button or select handler directly. */
export function createFakeComponentContext({
  state = "",
  values = [],
  guildId = "100000000000000001",
  place = guildId === null ? "bot-dm" : "guild",
  memberPermissions = 0n,
  userId = "200000000000000002",
}: FakeComponentContextOptions = {}): FakeComponentContext {
  const ctx: FakeComponentContext = {
    state,
    values,
    guildId,
    place,
    channelId: "300000000000000003",
    memberPermissions: guildId === null ? null : memberPermissions,
    user: { id: userId, displayName: "tester" },
    updates: [],
    replies: [],
    modals: [],
    deferred: false,
    get acknowledged() {
      return (
        ctx.deferred || ctx.updates.length > 0 || ctx.replies.length > 0 || ctx.modals.length > 0
      );
    },
    async showModal(modal) {
      if (ctx.acknowledged) throw new Error(NOT_FIRST_ANSWER);
      validateModal(modal);
      ctx.modals.push(modal);
    },
    async update(reply) {
      checkComponents(reply);
      ctx.updates.push(reply);
    },
    async defer() {
      ctx.deferred = true;
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
 * error policy) without Discord. The clicking user is the owner from the custom_id unless you pass `userId`.
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

export interface FakeModalContext extends ModalBaseContext {
  /** Every `update()`, in order. */
  readonly updates: Reply[];
  /** True after `defer()`, explicit or by `executeModal` when the handler said nothing. */
  deferred: boolean;
  /** Every `reply()`, in order. */
  readonly replies: Reply[];
}

export interface FakeModalContextOptions {
  state?: string;
  /** The modal was opened from a message component, so `update` works. Default false (opened by a slash command). */
  fromMessage?: boolean;
  guildId?: string | null;
  /** Defaults to `guild` with a guildId and `bot-dm` without. */
  place?: CommandPlace;
  memberPermissions?: bigint | null;
  userId?: string;
}

/** An in-memory modal context; `submitModal` adds the parsed `values` for the handler. */
export function createFakeModalContext({
  state = "",
  fromMessage = false,
  guildId = "100000000000000001",
  place = guildId === null ? "bot-dm" : "guild",
  memberPermissions = 0n,
  userId = "200000000000000002",
}: FakeModalContextOptions = {}): FakeModalContext {
  const ctx: FakeModalContext = {
    state,
    guildId,
    place,
    channelId: "300000000000000003",
    memberPermissions: guildId === null ? null : memberPermissions,
    user: { id: userId, displayName: "tester" },
    canUpdate: fromMessage,
    updates: [],
    replies: [],
    deferred: false,
    get acknowledged() {
      return ctx.deferred || ctx.updates.length > 0 || ctx.replies.length > 0;
    },
    async update(reply) {
      if (!ctx.canUpdate) throw new Error(NO_MODAL_UPDATE);
      checkComponents(reply);
      ctx.updates.push(reply);
    },
    async defer() {
      ctx.deferred = true;
    },
    async reply(reply) {
      checkComponents(reply);
      ctx.replies.push(reply);
    },
  };
  return ctx;
}

export interface SubmitOptions extends Omit<FakeModalContextOptions, "state"> {
  registry: CommandRegistry;
  /** `customId` of the `ModalSpec` the module opened (`ctx.modals[0].customId`). */
  customId: string;
  /** What the user typed or picked, keyed by field: text for inputs, ids for selects. */
  values?: ModalRawValues;
}

/**
 * Plays a modal submit through the same routing and checks as the bot (custom_id lookup, owner,
 * permissions, validation of the values, error policy) without Discord. The submitting user is the owner
 * from the custom_id unless you pass `userId`.
 */
export async function submitModal({
  registry,
  customId,
  values = {},
  ...options
}: SubmitOptions): Promise<FakeModalContext> {
  const resolved = registry.resolveModal(customId);
  const ctx = createFakeModalContext({
    userId: resolved?.owner,
    ...options,
    state: resolved?.state,
  });
  if (!resolved) {
    await ctx.reply({ content: UNKNOWN_MODAL, ephemeral: true });
    return ctx;
  }
  await executeModal(resolved, ctx, values, silentLogger);
  return ctx;
}

/** The text of a reply, whether it was a string or an object. */
export function replyText(reply: Reply | undefined): string | undefined {
  return typeof reply === "string" ? reply : reply?.content;
}

export interface FakeScheduler extends Scheduler {
  /** Tasks waiting to run. */
  readonly pending: number;
  /** Moves the clock forward and runs every task that came due, in order. */
  advance(ms: number): void;
}

/** A scheduler driven by `advance`, so a test "waits" 15 seconds instantly. */
export function createFakeScheduler(): FakeScheduler {
  let now = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; task: () => void }>();
  return {
    get pending() {
      return tasks.size;
    },
    after(delayMs, task) {
      const id = nextId++;
      tasks.set(id, { at: now + delayMs, task });
      return () => void tasks.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].task();
      }
      now = target;
    },
  };
}
