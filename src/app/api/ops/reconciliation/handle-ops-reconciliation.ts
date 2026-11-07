import { requestRun, retryRun } from "../../../../services/reconciliation";
import { getReconciliationOverview, getRunDetail } from "../../../../services/reconciliation-queries";
import { reconciliationListQuery, reconciliationRunBody, runIdParams, searchParamsObject } from "../../../_lib/schemas";
import { checkSameOrigin, invalidRequest, withRequestLog, type HandlerDeps } from "../../handler";
import { errorResponse } from "../../responses";
import { requireOps } from "../../session";

const notFound = () => errorResponse(404, "run_not_found", "No reconciliation run with that id");

/**
 * GET /api/ops/reconciliation — recent runs, counts by status across each provider's latest
 * successful run, and its open exceptions (everything but MATCHED, unresolved). Query: status.
 */
export async function handleReconciliationOverview(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/reconciliation", async ({ annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const query = reconciliationListQuery.safeParse(searchParamsObject(new URL(request.url).searchParams));
    if (!query.success) return invalidRequest(query.error);
    return Response.json(await getReconciliationOverview(deps.db, query.data));
  });
}

/**
 * POST /api/ops/reconciliation/run `{ provider, windowStart?, windowEnd? }` — 201 with a new
 * PENDING run for the worker, or 200 with the provider's run that is already PENDING or RUNNING.
 */
export async function handleRequestRun(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/reconciliation/run", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be JSON");
    }
    const body = reconciliationRunBody.safeParse(json);
    if (!body.success) return invalidRequest(body.error);
    const result = await requestRun(deps.db, { ...body.data, userId: ops.userId, correlationId });
    annotate({ run_id: result.run.id, provider: result.run.provider, run_outcome: result.outcome });
    if (result.outcome === "created") log.info({ run_id: result.run.id, provider: result.run.provider, to_status: "PENDING" }, "reconciliation run requested by Ops");
    return Response.json({ run: result.run, created: result.outcome === "created" }, { status: result.outcome === "created" ? 201 : 200 });
  });
}

/** GET /api/ops/reconciliation/:id — the run, every record with internal and external side by side, and its Ops actions. */
export async function handleGetRun(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/reconciliation/:id", async ({ annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const parsed = runIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ run_id: parsed.data.id });
    const detail = await getRunDetail(deps.db, parsed.data.id);
    return detail ? Response.json(detail) : notFound();
  });
}

/**
 * POST /api/ops/reconciliation/:id/retry — FAILED → PENDING with a fresh budget, audited. Any
 * other status, or another active run for the provider, is 409 and changes nothing.
 */
export async function handleRetryRun(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/reconciliation/:id/retry", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    const parsed = runIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ run_id: parsed.data.id });
    const result = await retryRun(deps.db, { runId: parsed.data.id, userId: ops.userId, correlationId });
    if (result.outcome === "not_found") return notFound();
    if (result.outcome === "not_retryable") {
      annotate({ run_status: result.status });
      return errorResponse(409, "run_not_retryable", `Only FAILED runs can be retried; this one is ${result.status}`);
    }
    if (result.outcome === "already_active") {
      return errorResponse(409, "run_already_active", "This provider already has a reconciliation run waiting or running");
    }
    log.info({ run_id: result.run.id, from_status: "FAILED", to_status: result.run.status, user_id: ops.userId }, "reconciliation run queued for retry by Ops");
    return Response.json({ run: result.run });
  });
}
