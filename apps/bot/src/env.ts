import { canonicalTimeZone, DEFAULT_TIME_ZONE, prefixProblem } from "@dzajcarz/core";
import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/, "expected a Discord id (17–20 digits)");
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** A flag: unset, empty, "0" and "false" are off; "1" and "true" are on; anything else is rejected. */
const FLAG_VALUES: Record<string, boolean> = {
  "": false,
  "0": false,
  false: false,
  "1": true,
  true: true,
};
const flag = z.preprocess(
  (value) => (value === undefined ? false : (FLAG_VALUES[String(value)] ?? value)),
  z.boolean(),
);

/** Bun.cron.parse throws on text it cannot read and returns null for an expression that never fires. */
function isCron(value: string): boolean {
  try {
    return Bun.cron.parse(value) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether the credentials of `scheme://user:password@host/…` parse as written. An unencoded `/`, `?` or `#`
 * in the password ends the host part early, and a second `@` is read differently by different parsers, so
 * the client would connect somewhere else or without the password. An `@` in the query string trips it too,
 * which is fine: compose never builds such a URL.
 */
export function credentialsIntact(value: string): boolean {
  const afterScheme = value.slice(value.indexOf("://") + 3);
  const at = afterScheme.lastIndexOf("@");
  if (at === -1) return true;
  const userinfo = afterScheme.slice(0, at);
  if (/[@/?#]/.test(userinfo)) return false;
  // `user:` with nothing after the colon is a password that got lost on the way, e.g. an unset variable.
  return !userinfo.endsWith(":");
}

const connectionUrl = (protocol: RegExp) =>
  z
    .string()
    .refine(
      credentialsIntact,
      "the password breaks the URL (an unencoded @ / ? # or an empty password); use a URL-safe password such as `openssl rand -hex 32`",
    )
    .pipe(z.url({ protocol }));

const EnvFields = z.object({
  // Production application. Optional only because a machine that runs nothing but the test bot has no use for it.
  DISCORD_TOKEN: optional(z.string().min(50)),
  DISCORD_CLIENT_ID: optional(snowflake),
  // Test application: both or neither. Set, they win over the production pair (see `chooseDiscordApp`).
  DISCORD_DEV_TOKEN: optional(z.string().min(50)),
  DISCORD_DEV_CLIENT_ID: optional(snowflake),
  DISCORD_DEV_GUILD_ID: optional(snowflake),
  BOT_PREFIX: z
    .string()
    .default("!")
    .refine(
      (value) => prefixProblem(value) === null,
      "expected 1-5 characters without spaces, invisible characters or a backtick (the /prefix rule)",
    ),
  DATABASE_URL: connectionUrl(/^postgres(ql)?$/),
  REDIS_URL: connectionUrl(/^rediss?$/),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Optional: without them the bot runs and music commands say the player is unavailable.
  LAVALINK_URL: optional(z.url({ protocol: /^https?$/ })),
  LAVALINK_PASSWORD: optional(z.string().min(1)),
  // Optional, one key per game: without it /valorant (or /lol) answers that stats are off.
  RIOT_VALORANT_API_KEY: optional(z.string().trim().min(1)),
  RIOT_LOL_API_KEY: optional(z.string().trim().min(1)),
  // When the scheduled song plays (five-field cron, read on each server's clock, see /timezone).
  SCHEDULED_SONG_CRON: z
    .string()
    .default("0 9,21 * * *")
    .refine(isCron, "expected a cron expression that fires"),
  // The time zone of servers that did not choose one with /timezone.
  DEFAULT_TIME_ZONE: z
    .string()
    .default(DEFAULT_TIME_ZONE)
    .refine(
      (value) => canonicalTimeZone(value) === value,
      "expected an IANA time zone name as spelled in the tz database, e.g. Europe/Warsaw",
    ),
  // The health endpoint (GET /health). 0 turns it off. The Docker image sets HEALTH_HOSTNAME=0.0.0.0 so a
  // published port reaches it.
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HEALTH_HOSTNAME: z.string().min(1).default("127.0.0.1"),
  // On unless set to 0/false: the bot registers its slash commands at startup. Turn it off when several
  // instances share the application.
  COMMANDS_AUTO_DEPLOY: z.preprocess(
    (value) => (value === undefined || value === "" ? "1" : value),
    flag,
  ),
  // Deploy the global set even when a dev guild is configured (and empty that guild), for the bot's
  // startup deploy and `commands:deploy` alike.
  DEPLOY_GLOBAL: flag,
});

interface DiscordFields {
  DISCORD_TOKEN?: string | undefined;
  DISCORD_CLIENT_ID?: string | undefined;
  DISCORD_DEV_TOKEN?: string | undefined;
  DISCORD_DEV_CLIENT_ID?: string | undefined;
}

/**
 * Picks the Discord application the process runs as. A complete test pair wins, so a local `bun run dev`
 * never logs in as the production bot; production never has the test pair because the compose file does
 * not pass it. `DISCORD_APP` says which one was picked, for the startup log.
 */
export function chooseDiscordApp(env: DiscordFields, ctx: z.RefinementCtx) {
  const devToken = env.DISCORD_DEV_TOKEN;
  const devClientId = env.DISCORD_DEV_CLIENT_ID;
  if ((devToken === undefined) !== (devClientId === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "set both DISCORD_DEV_TOKEN and DISCORD_DEV_CLIENT_ID, or neither",
      path: [devToken === undefined ? "DISCORD_DEV_TOKEN" : "DISCORD_DEV_CLIENT_ID"],
    });
    return z.NEVER;
  }
  if (devToken !== undefined && devClientId !== undefined) {
    return { DISCORD_TOKEN: devToken, DISCORD_CLIENT_ID: devClientId, DISCORD_APP: "dev" as const };
  }
  const { DISCORD_TOKEN: token, DISCORD_CLIENT_ID: clientId } = env;
  if (token === undefined || clientId === undefined) {
    ctx.addIssue({
      code: "custom",
      message:
        "set DISCORD_TOKEN and DISCORD_CLIENT_ID (production) or DISCORD_DEV_TOKEN and DISCORD_DEV_CLIENT_ID (test bot)",
      path: ["DISCORD_TOKEN"],
    });
    return z.NEVER;
  }
  return { DISCORD_TOKEN: token, DISCORD_CLIENT_ID: clientId, DISCORD_APP: "prod" as const };
}

export const Env = EnvFields.refine(
  (env) => (env.LAVALINK_URL === undefined) === (env.LAVALINK_PASSWORD === undefined),
  {
    message: "set both LAVALINK_URL and LAVALINK_PASSWORD, or neither",
    path: ["LAVALINK_PASSWORD"],
  },
).transform((env, ctx) => ({ ...env, ...chooseDiscordApp(env, ctx) }));
export type Env = z.infer<typeof Env>;

/** Just what deploying slash commands needs; no database or Redis. */
const DeployEnv = EnvFields.pick({
  DISCORD_TOKEN: true,
  DISCORD_CLIENT_ID: true,
  DISCORD_DEV_TOKEN: true,
  DISCORD_DEV_CLIENT_ID: true,
  DISCORD_DEV_GUILD_ID: true,
  DEPLOY_GLOBAL: true,
})
  .extend({ DEPLOY_CLEAR: flag })
  .transform((env, ctx) => ({ ...env, ...chooseDiscordApp(env, ctx) }));
export type DeployEnv = z.infer<typeof DeployEnv>;

function parse<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  return parsed.data;
}

export const loadEnv = (source: Record<string, string | undefined> = Bun.env): Env =>
  parse(Env, source);
export const loadDeployEnv = (source: Record<string, string | undefined> = Bun.env): DeployEnv =>
  parse(DeployEnv, source);
