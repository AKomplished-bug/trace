import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handlePaymentSimulation } from "../../handle-payment-simulation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { db, increase } = apiDeps();
  return handlePaymentSimulation({ db, provider: increase, logger }, "settle", request, await params);
}
