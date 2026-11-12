import { Snowflake } from "@dzajcarz/web-protocol";
import { z } from "zod";

/** A path parameter that must be a Discord id; undefined when it is not. */
export function idParam(request: Request, name: string): string | undefined {
  const value = (request as Request & { params?: Record<string, string> }).params?.[name];
  const parsed = Snowflake.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const invalidId = () => Response.json({ error: "invalid_id" }, { status: 400 });

export type Query<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The query string validated with `schema`; a repeated key keeps its last value. */
export function readQuery<S extends z.ZodType>(request: Request, schema: S): Query<z.infer<S>> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = schema.safeParse(params);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : {
        ok: false,
        response: Response.json(
          { error: "invalid_query", message: z.prettifyError(parsed.error) },
          { status: 400 },
        ),
      };
}
