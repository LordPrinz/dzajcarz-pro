import { z } from "zod";

/** Longest request body the panel reads. */
export const MAX_BODY_BYTES = 64 * 1024;

export type JsonBody<T> = { ok: true; data: T } | { ok: false; response: Response };

const bad = (status: number, error: string, message?: string): JsonBody<never> => ({
  ok: false,
  response: Response.json(message ? { error, message } : { error }, { status }),
});

/**
 * The body, read until it passes `limit` bytes: then the stream is cancelled and the answer is null. A body
 * without a length (chunked) is never buffered past the limit, whatever the server's own ceiling.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Reads a JSON body and validates it; a failure comes back as the response to send. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<JsonBody<z.infer<S>>> {
  const bytes = await readBody(request, MAX_BODY_BYTES);
  if (bytes === null) return bad(413, "payload_too_large");
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
