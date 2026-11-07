import type { z } from "zod";
import type { Db } from "../../db/client";
import { safeErrorForLog } from "../../lib/errors";
import { newId } from "../../lib/ids";
import type { Logger } from "../../lib/logger";
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

/**
 * Runs a handler with a request-scoped logger (correlation id, route) and logs one outcome line
 * per request — status, outcome code and the entity ids the handler annotated. Anything it
 * doesn't handle itself is logged and answered with a generic 500, never internal detail.
 * Handlers still check auth first (requireOwner / requireOps), inside this wrapper.
 */
export async function withRequestLog(
  deps: { logger: Logger },
  route: string,
  body: (scope: RequestScope) => Promise<Response>,
): Promise<Response> {
  const correlationId = newId();
  const log = deps.logger.child({ correlation_id: correlationId, route });
  const fields: Record<string, unknown> = {};
  let response: Response;
  try {
    response = await body({ log, correlationId, annotate: (more) => Object.assign(fields, more) });
  } catch (error) {
    log.error({ ...fields, outcome: "error", err: safeErrorForLog(error) }, "request failed");
    return errorResponse(500, "internal_error", "Something went wrong on our side; try again");
  }
  log.info({ ...fields, status: response.status, outcome: await outcomeOf(response) }, "request handled");
  return response;
}

/** 400 naming each invalid field, e.g. `type: Invalid option: expected one of …`. */
export function invalidRequest(error: z.ZodError): Response {
  const problems = error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  return errorResponse(400, "invalid_request", problems.join("; "));
}
