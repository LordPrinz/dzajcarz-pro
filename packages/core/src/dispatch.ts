import { type AnyCommand, type CommandContext, DEFAULT_CONTEXTS, type Reply } from "./command.ts";
import type { ComponentContext } from "./component.ts";
import { UserError } from "./errors.ts";
import type { Locale } from "./i18n.ts";
import type { Logger } from "./logger.ts";
import { common, coreMessages } from "./messages.ts";
import { type ModalBaseContext, type ModalRawValues, parseModalValues } from "./modal.ts";
import { hasPermissions } from "./permissions.ts";
import { splitInvocation, usage } from "./prefix.ts";
import type { ResolvedComponent, ResolvedModal } from "./registry.ts";
import { withTimeout } from "./timeout.ts";

type AccessContext = Pick<CommandContext, "guildId" | "place" | "memberPermissions" | "locale">;

/** What the cooldown check needs from a store; `KeyValueStore` from `@dzajcarz/kv` fits. */
export interface CooldownStore {
  /** Counts a call in a window that the first call opens for `ttlMs`. */
  increment(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }>;
}

/**
 * Runs a command with the checks every command shares (DMs, member permissions) and one error policy:
 * a UserError is shown to the caller, anything else is logged and replaced by a generic message.
 * With `cooldowns`, a command or subcommand that sets `cooldownMs` is limited per user across servers; when
 * the store fails or does not answer in time the command runs anyway.
 */
export async function executeCommand(
  command: AnyCommand,
  ctx: CommandContext,
  logger: Logger,
  cooldowns?: CooldownStore,
): Promise<void> {
  const log = logger.child({
    command: command.name,
    invocation: ctx.invocation,
    guildId: ctx.guildId,
    userId: ctx.user.id,
  });

  try {
    const denied = checkCommandAccess(command, ctx);
    if (denied) throw new UserError(denied);
    if (command.subcommands) {
      const { subcommand } = ctx;
      const target =
        subcommand !== undefined && Object.hasOwn(command.subcommands, subcommand)
          ? command.subcommands[subcommand]
          : undefined;
      if (!target) {
        throw new UserError((l) => coreMessages(l).unknownSubcommand(usage(command, undefined, l)));
      }
      const deniedAction = checkAccess(target, ctx);
      if (deniedAction) throw new UserError(deniedAction);
      await enforceCooldown(
        cooldowns,
        `cooldown:${command.name}:${subcommand}:${ctx.user.id}`,
        target.cooldownMs ?? command.cooldownMs,
        log,
      );
      await target.run(ctx);
    } else {
      await enforceCooldown(
        cooldowns,
        `cooldown:${command.name}:${ctx.user.id}`,
        command.cooldownMs,
        log,
      );
      await command.run?.(ctx);
    }
  } catch (error) {
    if (!(error instanceof UserError)) log.error("Command failed", { error });
    try {
      await ctx.reply({ content: errorText(error, ctx.locale), ephemeral: true });
    } catch (replyError) {
      // The interaction may have expired or the channel may be gone; nothing left to tell the user.
      log.warn("Could not report a command error to the caller", { error: replyError });
    }
  }
}

/** What the caller sees for a failure: a UserError's own text, anything else the generic message. */
function errorText(error: unknown, locale: Locale): string {
  return error instanceof UserError ? error.messageIn(locale) : common(locale).genericError;
}

/** Refuses the call while the user's previous one is inside the window. Fails open if the store is down. */
async function enforceCooldown(
  cooldowns: CooldownStore | undefined,
  key: string,
  cooldownMs: number | undefined,
  log: Logger,
): Promise<void> {
  if (!cooldowns || cooldownMs === undefined) return;
  let counter: { count: number; ttlMs: number };
  try {
    counter = await withTimeout(cooldowns.increment(key, cooldownMs));
  } catch (error) {
    log.warn("Cooldown check failed; running the command anyway", { error });
    return;
  }
  if (counter.count > 1) {
    const seconds = Math.max(1, Math.ceil(counter.ttlMs / 1000));
    throw new UserError((l) => coreMessages(l).cooldown(seconds));
  }
}

interface GatedContext
  extends Pick<CommandContext, "user" | "guildId" | "memberPermissions" | "locale"> {
  readonly acknowledged: boolean;
  defer(): Promise<void>;
  reply(reply: Reply): Promise<void>;
}

type Text = (locale: Locale) => string;

interface GateMessages extends AccessMessages {
  notOwner: Text;
  /** Log line for a failure that is not the user's fault. */
  failed: string;
  /** Log line when even the error reply fails. */
  replyFailed: string;
}

/**
 * The checks and error policy of anything a member opens from a message (a click, a modal submit): only the
 * member it was made for may use it, then its own guild/permission rules. A UserError is shown, anything else
 * is logged and replaced by a generic message, always as an ephemeral reply.
 */
async function runGated(
  target: { guildOnly?: boolean; permissions?: bigint; public?: boolean },
  owner: string,
  ctx: GatedContext,
  messages: GateMessages,
  log: Logger,
  run: () => Promise<void>,
  answerSilently: () => Promise<void>,
): Promise<void> {
  try {
    if (!target.public && ctx.user.id !== owner) throw new UserError(messages.notOwner);
    const denied = checkAccess(target, ctx, messages);
    if (denied) throw new UserError(denied);
    await run();
    // Discord shows "interaction failed" after 3 seconds without an answer.
    if (!ctx.acknowledged) await answerSilently();
  } catch (error) {
    if (!(error instanceof UserError)) log.error(messages.failed, { error });
    try {
      await ctx.reply({ content: errorText(error, ctx.locale), ephemeral: true });
    } catch (replyError) {
      log.warn(messages.replyFailed, { error: replyError });
    }
  }
}

const COMPONENT_MESSAGES: GateMessages = {
  notOwner: (l) => coreMessages(l).notYourMenu,
  guildOnly: (l) => coreMessages(l).menuGuildOnly,
  permissions: (l) => coreMessages(l).menuNoPermission,
  failed: "Component failed",
  replyFailed: "Could not report a component error to the user",
};

/** Runs a component handler after the checks every click shares (see `runGated`). */
export async function executeComponent(
  { component, owner }: ResolvedComponent,
  ctx: ComponentContext,
  logger: Logger,
): Promise<void> {
  const log = logger.child({
    component: `${component.module}:${component.name}`,
    guildId: ctx.guildId,
    userId: ctx.user.id,
  });
  await runGated(
    component,
    owner,
    ctx,
    COMPONENT_MESSAGES,
    log,
    () => component.run(ctx),
    () => ctx.defer(),
  );
}

const MODAL_MESSAGES: GateMessages = {
  notOwner: (l) => coreMessages(l).notYourModal,
  guildOnly: (l) => coreMessages(l).modalGuildOnly,
  permissions: (l) => coreMessages(l).modalNoPermission,
  failed: "Modal failed",
  replyFailed: "Modal failed: could not report error",
};

/**
 * Runs a modal handler after a submit: the owner and permission checks of a click, then the answers are
 * validated against the modal's fields (a problem is answered with an ephemeral message) and the
 * handler gets them as `ctx.values`.
 */
export async function executeModal(
  { modal, owner }: ResolvedModal,
  ctx: ModalBaseContext,
  raw: ModalRawValues,
  logger: Logger,
): Promise<void> {
  const log = logger.child({
    modal: `${modal.module}:${modal.name}`,
    guildId: ctx.guildId,
    userId: ctx.user.id,
  });
  await runGated(
    modal,
    owner,
    ctx,
    MODAL_MESSAGES,
    log,
    async () => {
      const values = parseModalValues(modal.fields, raw, ctx.locale);
      // An explicit wrapper instead of prototype delegation, so spreading `ctx` in a handler is safe.
      await modal.run({
        user: ctx.user,
        guildId: ctx.guildId,
        place: ctx.place,
        channelId: ctx.channelId,
        memberPermissions: ctx.memberPermissions,
        locale: ctx.locale,
        state: ctx.state,
        canUpdate: ctx.canUpdate,
        values,
        get acknowledged() {
          return ctx.acknowledged;
        },
        defer: (options) => ctx.defer(options),
        reply: (reply) => ctx.reply(reply),
        update: (reply) => ctx.update(reply),
      });
    },
    // A modal opened from a message leaves that message as it is; otherwise there is nothing to edit, so
    // the member gets a short ephemeral confirmation instead of a "thinking" state that never resolves.
    () =>
      ctx.canUpdate
        ? ctx.defer()
        : ctx.reply({ content: coreMessages(ctx.locale).modalDone, ephemeral: true }),
  );
}

/**
 * The pre-parse gate of a prefix invocation: the command's own access plus the permissions of the subcommand
 * named by the first word, so a member without access gets "no permission" instead of a usage error.
 */
export function checkPrefixAccess(
  command: AnyCommand,
  rest: string,
  ctx: AccessContext,
): string | null {
  const denied = checkCommandAccess(command, ctx);
  if (denied || !command.subcommands) return denied;
  const word = splitInvocation(rest)?.name;
  const picked =
    word !== undefined && Object.hasOwn(command.subcommands, word)
      ? command.subcommands[word]
      : undefined;
  return picked ? checkAccess(picked, ctx) : null;
}

/**
 * `checkAccess` for a command, preceded by the exact-place check: the command must allow the place the call
 * came from (a server, or a direct message with the bot). Discord enforces this for slash commands already;
 * prefix calls rely on this check alone.
 */
function checkCommandAccess(command: AnyCommand, ctx: AccessContext): string | null {
  const { places } = command.contexts ?? DEFAULT_CONTEXTS;
  if (!places.includes(ctx.place)) {
    const t = coreMessages(ctx.locale);
    if (ctx.place === "guild") return t.dmOnly;
    return places.includes("guild") ? common(ctx.locale).guildOnly : t.notHere;
  }
  return checkAccess({ permissions: command.permissions }, ctx);
}

interface AccessMessages {
  guildOnly: Text;
  permissions: Text;
}

const COMMAND_ACCESS: AccessMessages = {
  guildOnly: (l) => common(l).guildOnly,
  permissions: (l) => common(l).noPermission,
};

/**
 * Guild-only and member-permission gate shared by slash and prefix invocations. Returns the message to
 * show the caller, in their language, or null when access is fine.
 */
export function checkAccess(
  target: { guildOnly?: boolean; permissions?: bigint },
  {
    guildId,
    memberPermissions,
    locale,
  }: Pick<CommandContext, "guildId" | "memberPermissions" | "locale">,
  messages: AccessMessages = COMMAND_ACCESS,
): string | null {
  if ((target.guildOnly || target.permissions !== undefined) && guildId === null) {
    return messages.guildOnly(locale);
  }
  const required = target.permissions;
  if (required === undefined) return null;
  return hasPermissions(memberPermissions, required) ? null : messages.permissions(locale);
}
