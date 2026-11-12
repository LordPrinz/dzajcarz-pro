import type { Logger } from "@dzajcarz/core";
import type { ArchiveSettingsRepository } from "@dzajcarz/db";
import { type BotClient, COMMANDS } from "@dzajcarz/web-protocol";
import type { AuditedResult, Auditor } from "./audit.ts";
import { readJson } from "./http/json.ts";
import { idParam, invalidId } from "./http/params.ts";

export interface ArchiveRouteDeps {
  bot: Pick<BotClient, "request">;
  auditor: Auditor;
  /** Read straight from Postgres, so the settings show while the bot is down. */
  archiveSettings: Pick<ArchiveSettingsRepository, "listGuilds" | "dmEnabled">;
  logger: Logger;
  /** The HTTP answer for a result that is not ok (`failure` in server.ts). */
  failure: (result: Extract<AuditedResult<unknown>, { ok: false }>) => Response;
}

const GuildSettingsBody = COMMANDS["archive.guild.set"].request.omit({ guildId: true });
const DmBody = COMMANDS["archive.dm.set"].request;
const BackfillBody = COMMANDS["archive.backfill"].request.omit({ channelId: true });

/**
 * The archive endpoints (#145). Settings are read from Postgres; every change goes to the bot (which stores
 * it and refreshes its cache) through the audit log.
 */
export function archiveRoutes({
  bot,
  auditor,
  archiveSettings,
  logger,
  failure,
}: ArchiveRouteDeps) {
  const settings = async () => {
    try {
      const [guilds, dm] = await Promise.all([
        archiveSettings.listGuilds(),
        archiveSettings.dmEnabled(),
      ]);
      return Response.json({ dm: { enabled: dm }, guilds });
    } catch (error) {
      logger.error("Could not read the archive settings", { error });
      return Response.json({ error: "database_unavailable" }, { status: 503 });
    }
  };

  const setGuild = async (request: Request) => {
    const guildId = idParam(request, "guildId");
    if (!guildId) return invalidId();
    const body = await readJson(request, GuildSettingsBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(
      request,
      "archive.guild.set",
      { guildId, payload: body.data },
      () => bot.request("archive.guild.set", { guildId, ...body.data }),
    );
    return result.ok ? Response.json(result.data) : failure(result);
  };

  const setDm = async (request: Request) => {
    const body = await readJson(request, DmBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(request, "archive.dm.set", { payload: body.data }, () =>
      bot.request("archive.dm.set", body.data),
    );
    return result.ok ? Response.json(result.data) : failure(result);
  };

  const backfill = async (request: Request) => {
    const channelId = idParam(request, "channelId");
    if (!channelId) return invalidId();
    const body = await readJson(request, BackfillBody);
    if (!body.ok) return body.response;
    const result = await auditor.audited(
      request,
      "archive.backfill",
      { channelId, payload: body.data },
      () => bot.request("archive.backfill", { channelId, ...body.data }),
    );
    return result.ok ? Response.json(result.data) : failure(result);
  };

  const channels = async (request: Request) => {
    const guildId = idParam(request, "guildId");
    if (!guildId) return invalidId();
    const result = await bot.request("guilds.channels", { guildId });
    if (!result.ok) return failure(result);
    return result.data === null
      ? Response.json({ error: "unknown_guild" }, { status: 404 })
      : Response.json(result.data);
  };

  return {
    "/api/archive/settings": { GET: settings },
    "/api/archive/guilds/:guildId": { PUT: setGuild },
    "/api/archive/dm": { PUT: setDm },
    "/api/archive/channels/:channelId/backfill": { POST: backfill },
    "/api/guilds/:guildId/channels": { GET: channels },
  };
}
