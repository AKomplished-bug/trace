import { logger } from "../../../../../../lib/logger";
import { apiDeps } from "../../../../deps";
import { handleRetryEvent } from "../../handle-ops-events";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleRetryEvent({ db: apiDeps().db, logger }, request, await params);
}
