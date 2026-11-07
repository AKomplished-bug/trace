import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleReconciliationOverview } from "./handle-ops-reconciliation";

export async function GET(request: Request): Promise<Response> {
  return handleReconciliationOverview({ db: apiDeps().db, logger }, request);
}
