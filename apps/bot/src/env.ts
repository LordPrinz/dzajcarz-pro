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

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const EnvFields = z.object({
  DISCORD_TOKEN: z.string().min(50),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_DEV_GUILD_ID: optional(snowflake),
  BOT_PREFIX: z.string().min(1).max(5).default("!"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Optional: without them the bot runs and music commands say the player is unavailable.
  LAVALINK_URL: optional(z.url({ protocol: /^https?$/ })),
  LAVALINK_PASSWORD: optional(z.string().min(1)),
  // Optional: without it /valorant and /lol answer that stats are off.
  RIOT_API_KEY: optional(z.string().min(1)),
  // When the scheduled song plays (five-field cron, read in the time zone below).
  SCHEDULED_SONG_CRON: z
    .string()
    .default("0 9,21 * * *")
    .refine((value) => Bun.cron.parse(value) !== null, "expected a cron expression that fires"),
  SCHEDULED_SONG_TIMEZONE: z
    .string()
    .default("Europe/Warsaw")
    .refine(isTimeZone, "expected an IANA time zone, e.g. Europe/Warsaw"),
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
const Env = EnvFields.refine(
  (env) => (env.LAVALINK_URL === undefined) === (env.LAVALINK_PASSWORD === undefined),
  {
    message: "set both LAVALINK_URL and LAVALINK_PASSWORD, or neither",
    path: ["LAVALINK_PASSWORD"],
  },
);
export type Env = z.infer<typeof Env>;

/** Just what deploying slash commands needs; no database or Redis. */
const DeployEnv = EnvFields.pick({
  DISCORD_TOKEN: true,
  DISCORD_CLIENT_ID: true,
  DISCORD_DEV_GUILD_ID: true,
  DEPLOY_GLOBAL: true,
}).extend({ DEPLOY_CLEAR: flag });
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
