import { logger } from "../../../../../../lib/logger";
import { apiDeps } from "../../../../deps";
import { handleRetryRun } from "../../handle-ops-reconciliation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleRetryRun({ db: apiDeps().db, logger }, request, await params);
}
