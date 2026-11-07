import { logger } from "../../../../../../lib/logger";
import { apiDeps } from "../../../../deps";
import { handleResolveInvestigation } from "../../handle-ops-investigations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleResolveInvestigation({ db: apiDeps().db, logger }, request, await params);
}
