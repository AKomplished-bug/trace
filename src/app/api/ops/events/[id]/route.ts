import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleGetEvent } from "../handle-ops-events";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetEvent({ db: apiDeps().db, logger }, request, await params);
}
