import type { z } from "zod";
import { addNote, getInvestigationDetail, listInvestigations, openInvestigation, resolveInvestigation } from "../../../../services/investigations";
import {
  investigationIdParams,
  investigationListQuery,
  investigationNoteBody,
  openInvestigationBody,
  resolveInvestigationBody,
  searchParamsObject,
} from "../../../_lib/schemas";
import { checkSameOrigin, invalidRequest, withRequestLog, type HandlerDeps } from "../../handler";
import { errorResponse } from "../../responses";
import { requireOps } from "../../session";

const notFound = () => errorResponse(404, "investigation_not_found", "No investigation with that id");

async function jsonBody<S extends z.ZodType>(request: Request, schema: S): Promise<{ data: z.infer<S> } | Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be JSON");
  }
  const body = schema.safeParse(json);
  return body.success ? { data: body.data } : invalidRequest(body.error);
}

/** GET /api/ops/investigations — newest first (50). Query: status (OPEN, RESOLVED). */
export async function handleListInvestigations(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/investigations", async ({ annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const query = investigationListQuery.safeParse(searchParamsObject(new URL(request.url).searchParams));
    if (!query.success) return invalidRequest(query.error);
    return Response.json({ items: await listInvestigations(deps.db, query.data) });
  });
}

/** POST /api/ops/investigations `{ recordId }` — 201 with a new OPEN investigation, or 200 with the record's existing one. */
export async function handleOpenInvestigation(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/investigations", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    const body = await jsonBody(request, openInvestigationBody);
    if (body instanceof Response) return body;
    annotate({ record_id: body.data.recordId });
    const result = await openInvestigation(deps.db, { recordId: body.data.recordId, userId: ops.userId, correlationId });
    if (result.outcome === "record_not_found") return errorResponse(404, "record_not_found", "No reconciliation record with that id");
    if (result.outcome === "not_an_exception") return errorResponse(409, "not_an_exception", "This record matched; there is nothing to investigate");
    annotate({ investigation_id: result.investigation.id });
    if (result.outcome === "opened") log.info({ investigation_id: result.investigation.id, record_id: body.data.recordId, to_status: "OPEN" }, "investigation opened by Ops");
    return Response.json({ investigation: result.investigation, created: result.outcome === "opened" }, { status: result.outcome === "opened" ? 201 : 200 });
  });
}

/** GET /api/ops/investigations/:id — the record, the transaction's trace and replay, adjustment, notes and audit trail. */
export async function handleGetInvestigation(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/investigations/:id", async ({ log, annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const parsed = investigationIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ investigation_id: parsed.data.id });
    const detail = await getInvestigationDetail(deps.db, parsed.data.id, log);
    return detail ? Response.json(detail) : notFound();
  });
}

/** POST /api/ops/investigations/:id/notes `{ body }` — 201 with the note. */
export async function handleAddNote(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/investigations/:id/notes", async ({ annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    const parsed = investigationIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ investigation_id: parsed.data.id });
    const body = await jsonBody(request, investigationNoteBody);
    if (body instanceof Response) return body;
    const result = await addNote(deps.db, { investigationId: parsed.data.id, userId: ops.userId, body: body.data.body, correlationId });
    if (result.outcome === "not_found") return notFound();
    return Response.json({ note: result.note }, { status: 201 });
  });
}

/**
 * POST /api/ops/investigations/:id/resolve `{ note, adjustmentCents? }` — resolves it, optionally
 * posting a new ADJUSTMENT (signed cents): only on an AMOUNT_MISMATCH whose transaction has posted
 * (else 422), and only the amount that closes the gap as it stands now (else 409). A second
 * submit is 409 and posts nothing.
 */
export async function handleResolveInvestigation(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/investigations/:id/resolve", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    const parsed = investigationIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ investigation_id: parsed.data.id });
    const body = await jsonBody(request, resolveInvestigationBody);
    if (body instanceof Response) return body;
    const result = await resolveInvestigation(deps.db, { investigationId: parsed.data.id, userId: ops.userId, ...body.data, correlationId }, log);
    if (result.outcome === "not_found") return notFound();
    if (result.outcome === "already_resolved") return errorResponse(409, "already_resolved", "This investigation is already resolved");
    if (result.outcome === "adjustment_not_allowed") {
      return errorResponse(422, "adjustment_not_allowed", "Only an amount mismatch on a posted transaction can be adjusted; resolve this one with a note");
    }
    if (result.outcome === "adjustment_mismatch") {
      return errorResponse(
        409,
        "adjustment_mismatch",
        result.expectedCents === null
          ? "Trace already matches the provider's amount; resolve without an adjustment"
          : `The adjustment must be ${result.expectedCents} cents to bring Trace to the provider's amount`,
      );
    }
    annotate({ transaction_id: result.investigation.transactionId, adjustment_transaction_id: result.investigation.adjustmentTransactionId });
    return Response.json({ investigation: result.investigation });
  });
}
