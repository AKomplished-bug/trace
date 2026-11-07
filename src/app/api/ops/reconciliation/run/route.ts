import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleRequestRun } from "../handle-ops-reconciliation";

export async function POST(request: Request): Promise<Response> {
  return handleRequestRun({ db: apiDeps().db, logger }, request);
}
