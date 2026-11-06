import type { AnyCommand, CommandContext } from "./command.ts";
import { UserError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { splitInvocation, usage } from "./prefix.ts";

/** PermissionFlagsBits.Administrator: Discord grants every permission to it. */
const ADMINISTRATOR = 1n << 3n;

export const GENERIC_ERROR = "Coś poszło nie tak. Spróbuj ponownie za chwilę.";

/**
 * Runs a command with the checks every command shares (DMs, member permissions) and one error policy:
 * a UserError is shown to the caller, anything else is logged and replaced by a generic message.
 */
export async function executeCommand(
  command: AnyCommand,
  ctx: CommandContext,
  logger: Logger,
): Promise<void> {
  const log = logger.child({
    command: command.name,
    invocation: ctx.invocation,
    guildId: ctx.guildId,
    userId: ctx.user.id,
  });

  try {
    const denied = checkAccess(command, ctx);
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
      await target.run(ctx);
    } else {
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

/**
 * The pre-parse gate of a prefix invocation: the command's own access plus the permissions of the subcommand
 * named by the first word, so a member without access gets "no permission" instead of a usage error.
 */
export function checkPrefixAccess(
  command: AnyCommand,
  rest: string,
  ctx: Pick<CommandContext, "guildId" | "memberPermissions">,
): string | null {
  const denied = checkAccess(command, ctx);
  if (denied || !command.subcommands) return denied;
  const word = splitInvocation(rest)?.name;
  const picked =
    word !== undefined && Object.hasOwn(command.subcommands, word)
      ? command.subcommands[word]
      : undefined;
  return picked ? checkAccess(picked, ctx) : null;
}

/**
 * Guild-only and member-permission gate shared by slash and prefix invocations. Returns the Polish message
 * to show the caller, or null when access is fine.
 */
export function checkAccess(
  target: { guildOnly?: boolean; permissions?: bigint },
  { guildId, memberPermissions }: Pick<CommandContext, "guildId" | "memberPermissions">,
): string | null {
  if ((target.guildOnly || target.permissions !== undefined) && guildId === null) {
    return "Ta komenda działa tylko na serwerze.";
  }
  const required = target.permissions;
  if (required === undefined) return null;
  const granted = memberPermissions ?? 0n;
  const isAdmin = (granted & ADMINISTRATOR) === ADMINISTRATOR;
  if (!isAdmin && (granted & required) !== required) return "Nie masz uprawnień do tej komendy.";
  return null;
}
