import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleGetRun } from "../handle-ops-reconciliation";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetRun({ db: apiDeps().db, logger }, request, await params);
}
