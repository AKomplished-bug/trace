import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleGetReplay } from "../../handle-transactions";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetReplay({ db: apiDeps().db, logger }, request, await params);
}
