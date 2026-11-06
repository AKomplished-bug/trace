import { getTimeline, getTransactionDetail, listTransactions } from "../../../services/transaction-queries";
import { searchParamsObject, transactionIdParams, transactionListQuery } from "../../_lib/schemas";
import { invalidRequest, withRequestLog, type HandlerDeps } from "../handler";
import { errorResponse } from "../responses";
import { requireOwner } from "../session";

// Another business's transaction is indistinguishable from a missing one.
const notFound = () => errorResponse(404, "transaction_not_found", "No transaction with that id on your account");

/** GET /api/transactions — newest first. Query: type, status, limit (1–100), cursor. */
export async function handleListTransactions(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/transactions", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const query = transactionListQuery.safeParse(searchParamsObject(new URL(request.url).searchParams));
    if (!query.success) return invalidRequest(query.error);
    return Response.json(await listTransactions(deps.db, owner.accountId, query.data));
  });
}

/** GET /api/transactions/:id — transaction, ledger entries, holds, linked transactions, external records. */
export async function handleGetTransaction(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "GET /api/transactions/:id", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const parsed = transactionIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ transaction_id: parsed.data.id });
    const detail = await getTransactionDetail(deps.db, owner.accountId, parsed.data.id);
    return detail ? Response.json(detail) : notFound();
  });
}

/** GET /api/transactions/:id/timeline — the money trace in account_seq order, balances after each step. */
export async function handleGetTimeline(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "GET /api/transactions/:id/timeline", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const parsed = transactionIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ transaction_id: parsed.data.id });
    const steps = await getTimeline(deps.db, owner.accountId, parsed.data.id);
    return steps ? Response.json({ transactionId: parsed.data.id, steps }) : notFound();
  });
}
