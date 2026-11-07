import { logger } from "../../../../../../lib/logger";
import { apiDeps } from "../../../../deps";
import { handleRequeuePayment } from "../../handle-ops-payments";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleRequeuePayment({ db: apiDeps().db, logger }, request, await params);
}
