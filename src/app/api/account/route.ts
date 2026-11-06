import { logger } from "../../../lib/logger";
import { apiDeps } from "../deps";
import { handleGetAccount } from "./handle-account";

export async function GET(request: Request): Promise<Response> {
  return handleGetAccount({ db: apiDeps().db, logger }, request);
}
