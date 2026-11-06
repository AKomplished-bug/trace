import { logger } from "../../../lib/logger";
import { apiDeps } from "../deps";
import { handleCreatePayment, handleListPayments } from "./handle-payments";

export async function POST(request: Request): Promise<Response> {
  const { db, increase } = apiDeps();
  return handleCreatePayment({ db, provider: increase, logger }, request);
}

export async function GET(request: Request): Promise<Response> {
  return handleListPayments({ db: apiDeps().db, logger }, request);
}
