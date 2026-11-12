import {
  type BotClient,
  type BotResult,
  COMMANDS,
  MAX_MUSIC_QUERY_LENGTH,
  MAX_MUSIC_QUEUE_LENGTH,
  MusicControl,
  type MusicRejection,
  SLOW_MUSIC_TIMEOUT_MS,
} from "@dzajcarz/web-protocol";
import { z } from "zod";
import type { AuditedResult, Auditor } from "./audit.ts";
import { readJson } from "./http/json.ts";
import { idParam, invalidId, readQuery } from "./http/params.ts";

export interface MusicRouteDeps {
  bot: Pick<BotClient, "request">;
  auditor: Auditor;
  failure: (result: Extract<AuditedResult<unknown>, { ok: false }>) => Response;
}

const StateQuery = z
  .object({
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_MUSIC_QUEUE_LENGTH - 1)
      .default(0),
  })
  .strict();
const SearchQuery = z.object({ q: z.string().trim().min(1).max(MAX_MUSIC_QUERY_LENGTH) }).strict();
const JoinBody = COMMANDS["music.join"].request.omit({ guildId: true });
const EnqueueBody = COMMANDS["music.enqueue"].request.omit({ guildId: true });
const RemoveBody = COMMANDS["music.queue.remove"].request.omit({ guildId: true });
const MoveBody = COMMANDS["music.queue.move"].request.omit({ guildId: true });
const EmptyBody = z.object({}).strict();

type Outcome = { status: "ok" } | { status: "rejected"; reason: MusicRejection };

/** Joining, searching and loading a playlist wait on Discord and YouTube. */
const SLOW = { timeoutMs: SLOW_MUSIC_TIMEOUT_MS };

/**
 * The music endpoints (#148). Reads (the player, the voice channels, a search) change nothing and are not
 * audited; every change runs through the audit log with the validated request. A refusal by the bot is 422
 * with its reason, so the panel can say why.
 */
export function musicRoutes({ bot, auditor, failure }: MusicRouteDeps) {
  const answer = <T extends Outcome>(result: AuditedResult<T>): Response => {
    if (!result.ok) return failure(result);
    if (result.data.status === "rejected") {
      return Response.json({ error: "rejected", reason: result.data.reason }, { status: 422 });
    }
    return Response.json(result.data);
  };

  const state = async (request: Request) => {
    const guildId = idParam(request, "guildId");
    if (!guildId) return invalidId();
    const query = readQuery(request, StateQuery);
    if (!query.ok) return query.response;
    const result = await bot.request("music.state", { guildId, offset: query.data.offset });
    return result.ok ? Response.json(result.data) : failure(result);
  };

  const voiceChannels = async (request: Request) => {
    const guildId = idParam(request, "guildId");
    if (!guildId) return invalidId();
    const result = await bot.request("music.voice_channels", { guildId });
    if (!result.ok) return failure(result);
    return result.data === null
      ? Response.json({ error: "unknown_guild" }, { status: 404 })
      : Response.json(result.data);
  };

  const search = async (request: Request) => {
    const guildId = idParam(request, "guildId");
    if (!guildId) return invalidId();
    const query = readQuery(request, SearchQuery);
    if (!query.ok) return query.response;
    const result = await bot.request("music.search", { guildId, query: query.data.q }, SLOW);
    if (!result.ok) return failure(result);
    return result.data.status === "rejected"
      ? Response.json({ error: "rejected", reason: result.data.reason }, { status: 422 })
      : Response.json(result.data);
  };

  /** A change: the body checked with `schema`, audited as `action`, then sent as `run` builds it. */
  const change =
    <S extends z.ZodType, T extends Outcome>(
      action: string,
      schema: S,
      run: (guildId: string, body: z.infer<S>) => Promise<BotResult<T>>,
    ) =>
    async (request: Request) => {
      const guildId = idParam(request, "guildId");
      if (!guildId) return invalidId();
      const body = await readJson(request, schema);
      if (!body.ok) return body.response;
      return answer(
        await auditor.audited(request, action, { guildId, payload: body.data }, () =>
          run(guildId, body.data),
        ),
      );
    };

  /** `DELETE` without a body. */
  const clear = async (request: Request) => {
    const guildId = idParam(request, "guildId");
    if (!guildId) return invalidId();
    return answer(
      await auditor.audited(request, "music.queue.clear", { guildId }, () =>
        bot.request("music.queue.clear", { guildId }),
      ),
    );
  };

  return {
    "/api/music/:guildId/state": { GET: state },
    "/api/music/:guildId/voice-channels": { GET: voiceChannels },
    "/api/music/:guildId/search": { GET: search },
    "/api/music/:guildId/join": {
      POST: change("music.join", JoinBody, (guildId, body) =>
        bot.request("music.join", { guildId, ...body }, SLOW),
      ),
    },
    "/api/music/:guildId/queue": {
      POST: change("music.enqueue", EnqueueBody, (guildId, body) =>
        bot.request("music.enqueue", { guildId, ...body }, SLOW),
      ),
      DELETE: clear,
    },
    "/api/music/:guildId/queue/remove": {
      POST: change("music.queue.remove", RemoveBody, (guildId, body) =>
        bot.request("music.queue.remove", { guildId, ...body }),
      ),
    },
    "/api/music/:guildId/queue/move": {
      POST: change("music.queue.move", MoveBody, (guildId, body) =>
        bot.request("music.queue.move", { guildId, ...body }),
      ),
    },
    "/api/music/:guildId/queue/shuffle": {
      POST: change("music.queue.shuffle", EmptyBody, (guildId) =>
        bot.request("music.queue.shuffle", { guildId }),
      ),
    },
    "/api/music/:guildId/control": {
      POST: change("music.control", MusicControl, (guildId, control) =>
        bot.request("music.control", { guildId, control }),
      ),
    },
  };
}
