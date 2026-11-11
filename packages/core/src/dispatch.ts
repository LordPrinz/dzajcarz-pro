import { type AnyCommand, type CommandContext, DEFAULT_CONTEXTS, type Reply } from "./command.ts";
import type { ComponentContext } from "./component.ts";
import { UserError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { type ModalBaseContext, type ModalRawValues, parseModalValues } from "./modal.ts";
import { splitInvocation, usage } from "./prefix.ts";
import type { ResolvedComponent, ResolvedModal } from "./registry.ts";
import { withTimeout } from "./timeout.ts";

type AccessContext = Pick<CommandContext, "guildId" | "place" | "memberPermissions">;

/** PermissionFlagsBits.Administrator: Discord grants every permission to it. */
const ADMINISTRATOR = 1n << 3n;

/** What the cooldown check needs from a store; `KeyValueStore` from `@dzajcarz/kv` fits. */
export interface CooldownStore {
  /** Counts a call in a window that the first call opens for `ttlMs`. */
  increment(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }>;
}

export const GENERIC_ERROR = "Coś poszło nie tak. Spróbuj ponownie za chwilę.";

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
      if (!target) throw new UserError(`Nieznana podkomenda. ${usage(command)}`);
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
    const userFacing = error instanceof UserError;
    if (!userFacing) log.error("Command failed", { error });
    try {
      await ctx.reply({ content: userFacing ? error.message : GENERIC_ERROR, ephemeral: true });
    } catch (replyError) {
      // The interaction may have expired or the channel may be gone; nothing left to tell the user.
      log.warn("Could not report a command error to the caller", { error: replyError });
    }
  }
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
    throw new UserError(`Zwolnij. Spróbuj ponownie za ${seconds} s.`);
  }
}

export const MENU_GUILD_ONLY = "To menu działa tylko na serwerze.";
export const MENU_NO_PERMISSION = "Nie masz uprawnień do tego menu.";
export const NOT_YOUR_MENU = "To nie Twoje menu.";
export const UNKNOWN_COMPONENT = "To menu jest nieaktualne. Wywołaj komendę jeszcze raz.";

interface GatedContext extends Pick<CommandContext, "user" | "guildId" | "memberPermissions"> {
  readonly acknowledged: boolean;
  defer(): Promise<void>;
  reply(reply: Reply): Promise<void>;
}

interface GateMessages {
  notOwner: string;
  guildOnly: string;
  permissions: string;
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
    const userFacing = error instanceof UserError;
    if (!userFacing) log.error(messages.failed, { error });
    try {
      await ctx.reply({ content: userFacing ? error.message : GENERIC_ERROR, ephemeral: true });
    } catch (replyError) {
      log.warn(messages.replyFailed, { error: replyError });
    }
  }
}

const COMPONENT_MESSAGES: GateMessages = {
  notOwner: NOT_YOUR_MENU,
  guildOnly: MENU_GUILD_ONLY,
  permissions: MENU_NO_PERMISSION,
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

export const MODAL_GUILD_ONLY = "Ten formularz działa tylko na serwerze.";
export const MODAL_NO_PERMISSION = "Nie masz uprawnień do tego formularza.";
export const NOT_YOUR_MODAL = "To nie Twój formularz.";
export const MODAL_DONE = "Gotowe.";
export const UNKNOWN_MODAL = "Ten formularz jest nieaktualny. Wywołaj komendę jeszcze raz.";

const MODAL_MESSAGES: GateMessages = {
  notOwner: NOT_YOUR_MODAL,
  guildOnly: MODAL_GUILD_ONLY,
  permissions: MODAL_NO_PERMISSION,
  failed: "Modal failed",
  replyFailed: "Modal failed: could not report error",
};

/**
 * Runs a modal handler after a submit: the owner and permission checks of a click, then the answers are
 * validated against the modal's fields (a problem is answered with an ephemeral Polish message) and the
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
      const values = parseModalValues(modal.fields, raw);
      // An explicit wrapper instead of prototype delegation, so spreading `ctx` in a handler is safe.
      await modal.run({
        user: ctx.user,
        guildId: ctx.guildId,
        place: ctx.place,
        channelId: ctx.channelId,
        memberPermissions: ctx.memberPermissions,
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
    () => (ctx.canUpdate ? ctx.defer() : ctx.reply({ content: MODAL_DONE, ephemeral: true })),
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
    if (ctx.place === "guild") return "Ta komenda działa tylko w prywatnej wiadomości do bota.";
    return places.includes("guild")
      ? "Ta komenda działa tylko na serwerze."
      : "Ta komenda nie działa w tym miejscu.";
  }
  return checkAccess({ permissions: command.permissions }, ctx);
}

/**
 * Guild-only and member-permission gate shared by slash and prefix invocations. Returns the Polish message
 * to show the caller, or null when access is fine.
 */
export function checkAccess(
  target: { guildOnly?: boolean; permissions?: bigint },
  { guildId, memberPermissions }: Pick<CommandContext, "guildId" | "memberPermissions">,
  messages = {
    guildOnly: "Ta komenda działa tylko na serwerze.",
    permissions: "Nie masz uprawnień do tej komendy.",
  },
): string | null {
  if ((target.guildOnly || target.permissions !== undefined) && guildId === null) {
    return messages.guildOnly;
  }
  const required = target.permissions;
  if (required === undefined) return null;
  const granted = memberPermissions ?? 0n;
  const isAdmin = (granted & ADMINISTRATOR) === ADMINISTRATOR;
  if (!isAdmin && (granted & required) !== required) return messages.permissions;
  return null;
}
