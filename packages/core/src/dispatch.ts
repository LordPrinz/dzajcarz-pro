import type { AnyCommand, CommandContext } from "./command.ts";
import { UserError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { usage } from "./prefix.ts";

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
    if ((command.guildOnly || command.permissions !== undefined) && ctx.guildId === null) {
      throw new UserError("Ta komenda działa tylko na serwerze.");
    }
    requirePermissions(command.permissions, ctx);
    if (command.subcommands) {
      const { subcommand } = ctx;
      const target =
        subcommand !== undefined && Object.hasOwn(command.subcommands, subcommand)
          ? command.subcommands[subcommand]
          : undefined;
      if (!target) throw new UserError(`Nieznana podkomenda. ${usage(command)}`);
      if (target.permissions !== undefined && ctx.guildId === null) {
        throw new UserError("Ta komenda działa tylko na serwerze.");
      }
      requirePermissions(target.permissions, ctx);
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

function requirePermissions(required: bigint | undefined, ctx: CommandContext): void {
  if (required === undefined) return;
  const granted = ctx.memberPermissions ?? 0n;
  const isAdmin = (granted & ADMINISTRATOR) === ADMINISTRATOR;
  if (!isAdmin && (granted & required) !== required) {
    throw new UserError("Nie masz uprawnień do tej komendy.");
  }
}
