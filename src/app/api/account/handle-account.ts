import { getAccountSummary, getBalance } from "../../../services/account-queries";
import { withRequestLog, type HandlerDeps } from "../handler";
import { errorResponse } from "../responses";
import { requireOwner } from "../session";

const noAccount = () => errorResponse(404, "account_not_found", "Your business has no account yet");

/** GET /api/account — the signed-in owner's account and card summary. */
export async function handleGetAccount(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/account", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const summary = await getAccountSummary(deps.db, owner.accountId);
    return summary ? Response.json(summary) : noAccount();
  });
}

/** GET /api/account/balance — ledger, pending holds and payments, available, and the domain's explanation. */
export async function handleGetBalance(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/account/balance", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const balance = await getBalance(deps.db, owner.accountId);
    return balance ? Response.json(balance) : noAccount();
  });
}
