import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleGetInvestigation } from "../handle-ops-investigations";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetInvestigation({ db: apiDeps().db, logger }, request, await params);
}
