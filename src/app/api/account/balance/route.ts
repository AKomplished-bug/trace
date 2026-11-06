import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleGetBalance } from "../handle-account";

export async function GET(request: Request): Promise<Response> {
  return handleGetBalance({ db: apiDeps().db, logger }, request);
}
