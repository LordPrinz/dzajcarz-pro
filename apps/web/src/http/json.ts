import { z } from "zod";

/** Longest request body the panel reads. */
export const MAX_BODY_BYTES = 64 * 1024;

export type JsonBody<T> = { ok: true; data: T } | { ok: false; response: Response };

const bad = (status: number, error: string, message?: string): JsonBody<never> => ({
  ok: false,
  response: Response.json(message ? { error, message } : { error }, { status }),
});

/** Reads a JSON body and validates it; a failure comes back as the response to send. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<JsonBody<z.infer<S>>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return bad(413, "payload_too_large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return bad(413, "payload_too_large");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return bad(400, "invalid_json");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return bad(400, "invalid_body", z.prettifyError(parsed.error));
  return { ok: true, data: parsed.data };
}
