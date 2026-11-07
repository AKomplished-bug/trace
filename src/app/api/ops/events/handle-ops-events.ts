import { getEventDetail, listEvents, retryEvent } from "../../../../services/ops-events";
import { eventIdParams, eventListQuery, searchParamsObject } from "../../../_lib/schemas";
import { invalidRequest, withRequestLog, type HandlerDeps } from "../../handler";
import { errorResponse } from "../../responses";
import { requireOps } from "../../session";

const notFound = () => errorResponse(404, "event_not_found", "No external event with that id");

/**
 * GET /api/ops/events — newest first. Query: status, provider, type, limit (1–100), cursor.
 * Metadata only: the payload is never read or returned.
 */
export async function handleListEvents(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/events", async ({ annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const query = eventListQuery.safeParse(searchParamsObject(new URL(request.url).searchParams));
    if (!query.success) return invalidRequest(query.error);
    return Response.json(await listEvents(deps.db, query.data));
  });
}

/** GET /api/ops/events/:id — metadata, deliveries, trace steps it wrote, transactions touched, Ops actions. */
export async function handleGetEvent(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/events/:id", async ({ annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const parsed = eventIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ event_id: parsed.data.id });
    const detail = await getEventDetail(deps.db, parsed.data.id);
    // The payload can contain personal data; Ops sees that it exists, never its content.
    return detail ? Response.json({ ...detail, payload: "withheld" }) : notFound();
  });
}

/**
 * POST /api/ops/events/:id/retry — FAILED → RETRY with a fresh retry budget, audited. Anything
 * else (including a second click) is 409 and changes nothing.
 */
export async function handleRetryEvent(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/events/:id/retry", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const parsed = eventIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ event_id: parsed.data.id });
    const result = await retryEvent(deps.db, { eventId: parsed.data.id, userId: ops.userId, correlationId });
    if (result.outcome === "not_found") return notFound();
    if (result.outcome === "not_retryable") {
      annotate({ event_status: result.status });
      return errorResponse(409, "event_not_retryable", `Only FAILED events can be retried; this one is ${result.status}`);
    }
    log.info({ event_id: result.event.id, from_status: "FAILED", to_status: result.event.status, user_id: ops.userId }, "event queued for retry by Ops");
    return Response.json({ event: result.event });
  });
}
