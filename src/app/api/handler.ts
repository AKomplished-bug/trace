import type { z } from "zod";
import type { Db } from "../../db/client";
import { safeErrorForLog } from "../../lib/errors";
import { newId } from "../../lib/ids";
import type { Logger } from "../../lib/logger";
import { recordRequestDuration } from "../../services/latency";
import { errorResponse } from "./responses";

export interface HandlerDeps {
  db: Db;
  logger: Logger;
}

export interface RequestScope {
  log: Logger;
  /** This request's correlation id (on every log line; recorded with audit events). */
  correlationId: string;
  /** Entity ids for the outcome line (e.g. account_id, transaction_id), once known. */
  annotate(fields: Record<string, unknown>): void;
}

// The outcome of a response: "ok", "redirect", or the error code from `{ error: { code } }`.
async function outcomeOf(response: Response): Promise<string> {
  if (response.ok) return "ok";
  if (response.status >= 300 && response.status < 400) return "redirect";
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === "string" ? body.error.code : `status_${response.status}`;
}

// `Server-Timing: app;dur=<ms>`, so devtools show time in the app apart from the network. A
// response with immutable headers is copied rather than letting the header fail the request.
function withServerTiming(response: Response, durationMs: number): Response {
  const value = `app;dur=${durationMs}`;
  try {
    response.headers.set("Server-Timing", value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set("Server-Timing", value);
    return copy;
  }
}

/**
 * Runs a handler with a request-scoped logger (correlation id, route) and logs one outcome line
 * per request — status, outcome code and the entity ids the handler annotated. Anything it
 * doesn't handle itself is logged and answered with a generic 500, never internal detail. Every
 * response carries its duration: `duration_ms` on the line, a Server-Timing header and the
 * `http_request_duration_ms` histogram (services/latency.ts).
 * Handlers still check auth first (requireOwner / requireOps), inside this wrapper.
 */
export async function withRequestLog(
  deps: { logger: Logger },
  route: string,
  body: (scope: RequestScope) => Promise<Response>,
): Promise<Response> {
  const startedAt = performance.now();
  const correlationId = newId();
  const log = deps.logger.child({ correlation_id: correlationId, route });
  const fields: Record<string, unknown> = {};
  let response: Response;
  try {
    response = await body({ log, correlationId, annotate: (more) => Object.assign(fields, more) });
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    recordRequestDuration(route, durationMs);
    log.error({ ...fields, outcome: "error", duration_ms: durationMs, err: safeErrorForLog(error) }, "request failed");
    return withServerTiming(errorResponse(500, "internal_error", "Something went wrong on our side; try again"), durationMs);
  }
  const durationMs = Math.round(performance.now() - startedAt);
  recordRequestDuration(route, durationMs);
  log.info({ ...fields, status: response.status, outcome: await outcomeOf(response), duration_ms: durationMs }, "request handled");
  return withServerTiming(response, durationMs);
}

/** 400 naming each invalid field, e.g. `type: Invalid option: expected one of …`. */
export function invalidRequest(error: z.ZodError): Response {
  const problems = error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  return errorResponse(400, "invalid_request", problems.join("; "));
}

/**
 * CSRF guard for unsafe requests: a request whose Origin is present must come from this host
 * (403 `cross_origin`), on top of the SameSite=Lax cookie. Null when it may go ahead.
 */
export function checkSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    // "null" or garbage: treated as cross-origin below.
  }
  return originHost === host ? null : errorResponse(403, "cross_origin", "This request must come from the Trace app");
}
