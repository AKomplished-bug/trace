import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleListEvents } from "./handle-ops-events";

export async function GET(request: Request): Promise<Response> {
  return handleListEvents({ db: apiDeps().db, logger }, request);
}
