import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleGetTimeline } from "../../handle-transactions";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetTimeline({ db: apiDeps().db, logger }, request, await params);
}
