import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleGetMetrics } from "./handle-metrics";

export async function GET(request: Request): Promise<Response> {
  return handleGetMetrics({ db: apiDeps().db, logger }, request);
}
