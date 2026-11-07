import { logger } from "../../../../../../lib/logger";
import { apiDeps } from "../../../../deps";
import { handleConfirmPaymentNotSent } from "../../handle-ops-payments";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { db, increase } = apiDeps();
  return handleConfirmPaymentNotSent({ db, provider: increase, logger }, request, await params);
}
