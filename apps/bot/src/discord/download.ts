/** Hosts Discord serves uploaded files from. Anything else is never contacted. */
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const DOWNLOAD_TIMEOUT_MS = 15_000;

function isDiscordCdnUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      DISCORD_CDN_HOSTS.has(url.hostname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Downloads a file Discord resolved for an upload. Only https URLs on Discord's CDN are fetched, redirects are
 * refused (a redirect could leave the CDN), and the body is cut off at `maxBytes` and after a timeout.
 * Null for any failure.
 */
export async function downloadDiscordFile(
  url: string,
  maxBytes: number,
  fetchFile: typeof fetch = fetch,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  if (!isDiscordCdnUrl(url)) return null;
  try {
    const response = await fetchFile(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) return null;
      chunks.push(chunk);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  } catch {
    return null;
  }
}
