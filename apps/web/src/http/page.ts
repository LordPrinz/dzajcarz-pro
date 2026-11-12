import { basename, join } from "node:path";
import indexHtml from "../ui/index.html";

export interface PageFile {
  body: Uint8Array;
  type: string;
  etag: string;
  /** Hashed asset names never change content; the HTML itself must be revalidated. */
  immutable: boolean;
}

/** The page and its assets by URL path (`/`, `/chunk-….js`, …). */
export type PageFiles = ReadonlyMap<string, PageFile>;

const isHtml = (type: string) => type.startsWith("text/html");

/**
 * Reads the page and its assets into memory once, so plain handlers serve them: Bun's built-in routes for
 * HTML imports take no response headers, and every response needs the security headers. A compiled binary
 * carries the built files (`files`); `bun src/index.ts` and the tests build them here.
 */
export async function loadPage(): Promise<PageFiles> {
  const page = new Map<string, PageFile>();
  if (indexHtml.files) {
    for (const file of indexHtml.files) {
      const type = file.headers["content-type"];
      page.set(isHtml(type) ? "/" : `/${basename(file.path)}`, {
        body: await Bun.file(file.path).bytes(),
        type,
        etag: `"${file.headers.etag}"`,
        immutable: !isHtml(type),
      });
    }
    return page;
  }
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../ui/index.html")],
    minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build the panel's page");
  for (const output of build.outputs) {
    const body = new Uint8Array(await output.arrayBuffer());
    page.set(isHtml(output.type) ? "/" : `/${basename(output.path)}`, {
      body,
      type: output.type,
      etag: `"${output.hash ?? Bun.hash(body).toString(36)}"`,
      immutable: !isHtml(output.type),
    });
  }
  return page;
}

/**
 * Whether an `If-None-Match` value names `etag`: `*`, or a comma-separated list compared weakly (RFC 9110
 * 13.1.2), so `W/"x"` matches `"x"`.
 */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => opaque(tag) === opaque(etag));
}

type PageHandler = (request: Request) => Response;

/** GET and HEAD handlers per file, with ETag revalidation. */
export function pageRoutes(
  page: PageFiles,
): Record<string, { GET: PageHandler; HEAD: PageHandler }> {
  return Object.fromEntries(
    [...page].map(([path, file]) => {
      const headers = {
        "Content-Type": file.type,
        ETag: file.etag,
        "Cache-Control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      };
      const answer = (request: Request, withBody: boolean) => {
        if (etagMatches(request.headers.get("if-none-match"), file.etag)) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(withBody ? file.body : null, {
          headers: { ...headers, "Content-Length": String(file.body.byteLength) },
        });
      };
      return [
        path,
        {
          GET(request: Request) {
            return answer(request, true);
          },
          HEAD(request: Request) {
            return answer(request, false);
          },
        },
      ];
    }),
  );
}
