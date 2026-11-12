import type { Logger } from "@dzajcarz/core";
import { isStagingFull, type UploadStaging } from "@dzajcarz/db";
import {
  type BotClient,
  type BotResult,
  COMMANDS,
  MAX_FILE_NAME_LENGTH,
  MAX_MEMBER_QUERY_LENGTH,
  MAX_UPLOAD_BYTES,
  MIN_MEMBER_QUERY_LENGTH,
  SendMessageBody,
  Snowflake,
  type WriteRejection,
} from "@dzajcarz/web-protocol";
import { z } from "zod";
import type { AuditedResult, Auditor } from "./audit.ts";
import { binaryBody } from "./http/guard.ts";
import { readBody, readJson } from "./http/json.ts";
import { idParam, invalidId, readQuery } from "./http/params.ts";

export interface WritingRouteDeps {
  bot: Pick<BotClient, "request">;
  auditor: Auditor;
  /** Where files wait for their message; the panel may only add to it. */
  uploads: UploadStaging;
  logger: Logger;
  failure: (result: Extract<AuditedResult<unknown>, { ok: false }>) => Response;
}

const EditBody = COMMANDS["message.edit"].request.omit({ channelId: true, messageId: true });
const ReactionBody = COMMANDS["reaction.add"].request.pick({ emoji: true });
const OpenDmBody = COMMANDS["dm.open"].request;

/**
 * Control characters, slashes, and the invisible and direction-changing characters that can make a name read
 * as something else (`photo\u202Egnp.exe` shows as `photoexe.png`).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNSAFE_NAME = /[\x00-\x1f\x7f/\\\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/** Uploads handled at once; more wait in the browser instead of in this process's memory. */
export const MAX_CONCURRENT_UPLOADS = 2;

const UploadQuery = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_FILE_NAME_LENGTH)
      .refine(
        (name) => !UNSAFE_NAME.test(name),
        "no control, invisible or direction characters, and no slashes",
      ),
  })
  .strict();

const MembersQuery = z
  .object({
    q: z.string().trim().min(MIN_MEMBER_QUERY_LENGTH).max(MAX_MEMBER_QUERY_LENGTH),
    guild: Snowflake.optional(),
  })
  .strict();

type Outcome = { status: "ok" } | { status: "rejected"; reason: WriteRejection };

/**
 * The writing endpoints (#147). Every action runs through the audit log with what was asked (the text in
 * full: the archive keeps it anyway, and the schema caps it at 2000 characters); a refusal by the bot is
 * answered 422 with its reason, so the panel can say why.
 */
export function writingRoutes({ bot, auditor, uploads, logger, failure }: WritingRouteDeps) {
  const answer = <T extends Outcome>(result: AuditedResult<T>, status = 200): Response => {
    if (!result.ok) return failure(result);
    if (result.data.status === "rejected") {
      return Response.json({ error: "rejected", reason: result.data.reason }, { status: 422 });
    }
    return Response.json(result.data, { status });
  };

  const info = async (request: Request) => {
    const channelId = idParam(request, "channelId");
    if (!channelId) return invalidId();
    const result = await bot.request("channel.info", { channelId });
    if (!result.ok) return failure(result);
    return result.data.status === "ok"
      ? Response.json(result.data)
      : Response.json({ error: "unknown_channel" }, { status: 404 });
  };

  let uploading = 0;

  /** One file, raw, staged in Postgres until a message takes it (ADR 9). */
  const upload = binaryBody(async (request: Request) => {
    const query = readQuery(request, UploadQuery);
    if (!query.ok) return query.response;
    // Each upload may hold 25 MiB in memory; a third one waits for its turn in the browser.
    if (uploading >= MAX_CONCURRENT_UPLOADS) {
      return Response.json(
        { error: "uploads_busy" },
        { status: 429, headers: { "Retry-After": "1" } },
      );
    }
    uploading++;
    try {
      return await stage(request, query.data.name);
    } finally {
      uploading--;
    }
  });

  async function stage(request: Request, name: string): Promise<Response> {
    const data = await readBody(request, MAX_UPLOAD_BYTES);
    if (data === null) return Response.json({ error: "payload_too_large" }, { status: 413 });
    if (data.byteLength === 0) return Response.json({ error: "empty_file" }, { status: 400 });
    const id = crypto.randomUUID();
    let full = false;
    const result = await auditor.audited(
      request,
      "upload.stage",
      { payload: { id, name, size: data.byteLength } },
      async (): Promise<BotResult<{ id: string }>> => {
        try {
          await uploads.stage({ id, name, data });
          return { ok: true, data: { id } };
        } catch (error) {
          full = isStagingFull(error);
          if (!full) logger.error("Could not stage an upload", { error });
          return { ok: false, reason: "error", message: full ? "staging full" : "database" };
        }
      },
    );
    if (!result.ok) {
      if (full) return Response.json({ error: "uploads_full" }, { status: 503 });
      return result.reason === "error"
        ? Response.json({ error: "database_unavailable" }, { status: 503 })
        : failure(result);
    }
    return Response.json({ id, name, size: data.byteLength }, { status: 201 });
  }

  const send = async (request: Request) => {
    const channelId = idParam(request, "channelId");
    if (!channelId) return invalidId();
    const body = await readJson(request, SendMessageBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(
      request,
      "message.send",
      { channelId, payload: body.data },
      () => bot.request("message.send", { channelId, ...body.data }),
    );
    return answer(result, 201);
  };

  const edit = async (request: Request) => {
    const channelId = idParam(request, "channelId");
    const messageId = idParam(request, "messageId");
    if (!channelId || !messageId) return invalidId();
    const body = await readJson(request, EditBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(
      request,
      "message.edit",
      { channelId, payload: { messageId, ...body.data } },
      () => bot.request("message.edit", { channelId, messageId, ...body.data }),
    );
    return answer(result);
  };

  const remove = async (request: Request) => {
    const channelId = idParam(request, "channelId");
    const messageId = idParam(request, "messageId");
    if (!channelId || !messageId) return invalidId();
    const result = await auditor.audited(
      request,
      "message.delete",
      { channelId, payload: { messageId } },
      () => bot.request("message.delete", { channelId, messageId }),
    );
    return answer(result);
  };

  const reaction = (command: "reaction.add" | "reaction.remove") => async (request: Request) => {
    const channelId = idParam(request, "channelId");
    const messageId = idParam(request, "messageId");
    if (!channelId || !messageId) return invalidId();
    const body = await readJson(request, ReactionBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(
      request,
      command,
      { channelId, payload: { messageId, ...body.data } },
      () => bot.request(command, { channelId, messageId, ...body.data }),
    );
    return answer(result);
  };

  const members = async (request: Request) => {
    const query = readQuery(request, MembersQuery);
    if (!query.ok) return query.response;
    const result = await bot.request("members.search", {
      guildId: query.data.guild ?? null,
      query: query.data.q,
    });
    return result.ok ? Response.json(result.data) : failure(result);
  };

  const openDm = async (request: Request) => {
    const body = await readJson(request, OpenDmBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(request, "dm.open", { payload: body.data }, () =>
      bot.request("dm.open", body.data),
    );
    return answer(result);
  };

  return {
    "/api/channels/:channelId/info": { GET: info },
    "/api/uploads": { POST: upload },
    "/api/channels/:channelId/messages": { POST: send },
    "/api/channels/:channelId/messages/:messageId": { PATCH: edit, DELETE: remove },
    "/api/channels/:channelId/messages/:messageId/reactions": {
      PUT: reaction("reaction.add"),
      DELETE: reaction("reaction.remove"),
    },
    "/api/members": { GET: members },
    "/api/dms/open": { POST: openDm },
  };
}
