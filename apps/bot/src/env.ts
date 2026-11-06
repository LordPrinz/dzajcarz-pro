import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/, "expected a Discord id (17–20 digits)");
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const Env = z.object({
  DISCORD_TOKEN: z.string().min(50),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_DEV_GUILD_ID: optional(snowflake),
  BOT_PREFIX: z.string().min(1).max(5).default("!"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type Env = z.infer<typeof Env>;

/** Just what deploying slash commands needs; no database or Redis. */
const DeployEnv = Env.pick({
  DISCORD_TOKEN: true,
  DISCORD_CLIENT_ID: true,
  DISCORD_DEV_GUILD_ID: true,
});
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
