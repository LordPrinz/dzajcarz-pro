import { z } from "zod";

export const Snowflake = z.string().regex(/^\d{17,20}$/, "expected a Discord id (17-20 digits)");

export const GuildSummary = z.object({
  id: Snowflake,
  name: z.string(),
  // Rendered as an <img> in the panel, so only Discord's CDN (which the CSP allows too).
  iconUrl: z
    .url({ protocol: /^https$/, hostname: /^cdn\.discordapp\.com$/ })
    .max(512)
    .nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type GuildSummary = z.infer<typeof GuildSummary>;

/** Every command the panel can send: a schema for the request and one for the response. */
export const COMMANDS = {
  "guilds.list": {
    request: z.object({}).strict(),
    response: z.array(GuildSummary),
  },
} as const;

export type CommandName = keyof typeof COMMANDS;
export type CommandRequest<N extends CommandName> = z.infer<(typeof COMMANDS)[N]["request"]>;
export type CommandResponse<N extends CommandName> = z.infer<(typeof COMMANDS)[N]["response"]>;

export const isCommandName = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);
