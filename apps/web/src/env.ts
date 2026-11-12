import { credentialsIntact } from "@dzajcarz/core";
import { z } from "zod";

const connectionUrl = (protocol: RegExp) =>
  z
    .string()
    .refine(
      credentialsIntact,
      "the password breaks the URL (an unencoded @ / ? # or an empty password); use a URL-safe password such as `openssl rand -hex 32`",
    )
    .pipe(z.url({ protocol }));

/** What compose can write into the Redis config unquoted, so the same rule holds for WEB_REDIS_PASSWORD. */
const REDIS_PASSWORD = /^[A-Za-z0-9._~-]+$/;

const emptyIsUnset = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const Env = z.object({
  // The address people type to reach the panel (the proxy's public URL), as a bare origin. The Host and
  // Origin checks compare against it.
  WEB_PUBLIC_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .refine(
      (value) => URL.canParse(value) && new URL(value).origin === value,
      "expected a bare origin such as https://panel.example.com (no path, query or trailing slash)",
    ),
  // The Docker image sets WEB_HOSTNAME=0.0.0.0; the container publishes no port, so only the compose
  // network reaches it.
  WEB_PORT: z.preprocess(emptyIsUnset, z.coerce.number().int().min(1).max(65535).default(3000)),
  WEB_HOSTNAME: z.preprocess(emptyIsUnset, z.string().min(1).default("127.0.0.1")),
  // The panel's own, least-privileged logins (ADR 9): the `dzajcarz_web` Postgres role and the `web` Redis
  // user. Not the bot's DATABASE_URL and REDIS_URL, so the panel never runs as the bot.
  WEB_DATABASE_URL: connectionUrl(/^postgres(ql)?$/),
  WEB_REDIS_URL: connectionUrl(/^rediss?$/)
    .refine(
      (value) => ["", "/", "/0"].includes(new URL(value).pathname),
      "use database 0 (or none): the panel's Redis user may not run SELECT",
    )
    .refine((value) => {
      const { password } = new URL(value);
      return password === "" || REDIS_PASSWORD.test(password);
    }, "the password may hold only letters, digits and . _ ~ - (compose writes it into the Redis config); `openssl rand -hex 32` fits"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // How long the panel waits for the bot to answer a command. At most 25 s: the bot drops a command whose
  // deadline is more than 30 s ahead, and the rest is headroom for clock skew between the two hosts.
  BOT_REQUEST_TIMEOUT_MS: z.preprocess(
    emptyIsUnset,
    z.coerce.number().int().min(500).max(25_000).default(3_000),
  ),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  return parsed.data;
}
