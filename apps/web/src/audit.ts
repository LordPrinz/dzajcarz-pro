import { type Logger, withTimeout } from "@dzajcarz/core";
import type { FinalWebAuditOutcome, WebAuditRepository } from "@dzajcarz/db";
import type { BotResult } from "@dzajcarz/web-protocol";

export interface AuditContext {
  guildId?: string | null;
  channelId?: string | null;
  /** Validated by the caller's zod schema before it gets here. */
  payload?: unknown;
}

const ACTOR_HEADER = "x-authentik-username";
const MAX_ACTOR_LENGTH = 255;
const MAX_ERROR_LENGTH = 1_000;
/** Longest an audit write may take; a stalled database must not hold the request until the proxy gives up. */
const AUDIT_TIMEOUT_MS = 1_500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;

/**
 * Who the proxy says made the request, without control characters (no forged lines in a log or terminal).
 * Attribution only: never use it to decide what is allowed.
 */
export function actorOf(request: Request): string | null {
  const actor = request.headers
    .get(ACTOR_HEADER)
    ?.replace(CONTROL_CHARACTERS, "")
    .trim()
    .slice(0, MAX_ACTOR_LENGTH)
    .trim();
  return actor || null;
}

/** What `audited` returns: the action's own result, or that it never ran because it could not be recorded. */
export type AuditedResult<T> = BotResult<T> | { ok: false; reason: "audit_unavailable" };

function outcomeOf(result: BotResult<unknown>): {
  outcome: FinalWebAuditOutcome;
  error: string | null;
} {
  if (result.ok) return { outcome: "ok", error: null };
  if (result.reason === "error") return { outcome: "failed", error: result.message ?? null };
  return { outcome: result.reason, error: null };
}

export interface Auditor {
  /**
   * Runs a state-changing action only once its `pending` row is written (fail closed: no row, no action),
   * then sets the row's outcome. A failing final write is logged and never changes what the caller gets.
   */
  audited<T>(
    request: Request,
    action: string,
    context: AuditContext,
    run: () => Promise<BotResult<T>>,
  ): Promise<AuditedResult<T>>;
}

export function createAuditor({
  repository,
  logger,
  timeoutMs = AUDIT_TIMEOUT_MS,
}: {
  repository: WebAuditRepository;
  logger: Logger;
  timeoutMs?: number;
}): Auditor {
  async function finish(
    id: number,
    action: string,
    outcome: FinalWebAuditOutcome,
    error: string | null,
  ) {
    try {
      await withTimeout(
        repository.finish(id, outcome, error?.slice(0, MAX_ERROR_LENGTH) ?? null),
        timeoutMs,
      );
    } catch (cause) {
      logger.error("Could not record the outcome in the audit log", {
        id,
        action,
        outcome,
        error: cause,
      });
    }
  }

  return {
    async audited<T>(
      request: Request,
      action: string,
      context: AuditContext,
      run: () => Promise<BotResult<T>>,
    ): Promise<AuditedResult<T>> {
      let id: number;
      try {
        // A row that lands after the timeout stays pending, which is true: the action never ran.
        ({ id } = await withTimeout(
          repository.start({
            actor: actorOf(request),
            action,
            guildId: context.guildId ?? null,
            channelId: context.channelId ?? null,
            payload: context.payload ?? {},
          }),
          timeoutMs,
        ));
      } catch (cause) {
        logger.error("Could not write the audit log; the action did not run", {
          action,
          error: cause,
        });
        return { ok: false, reason: "audit_unavailable" };
      }
      let result: BotResult<T>;
      try {
        result = await run();
      } catch (error) {
        await finish(id, action, "failed", error instanceof Error ? error.message : String(error));
        throw error;
      }
      const { outcome, error } = outcomeOf(result);
      await finish(id, action, outcome, error);
      return result;
    },
  };
}
