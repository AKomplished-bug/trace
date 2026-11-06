import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleGetPayment } from "../handle-payments";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetPayment({ db: apiDeps().db, logger }, request, await params);
}
