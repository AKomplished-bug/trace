import { logger } from "../../../lib/logger";
import { apiDeps } from "../deps";
import { handleListTransactions } from "./handle-transactions";

export async function GET(request: Request): Promise<Response> {
  return handleListTransactions({ db: apiDeps().db, logger }, request);
}
