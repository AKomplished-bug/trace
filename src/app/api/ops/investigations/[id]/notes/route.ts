import { logger } from "../../../../../../lib/logger";
import { apiDeps } from "../../../../deps";
import { handleAddNote } from "../../handle-ops-investigations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleAddNote({ db: apiDeps().db, logger }, request, await params);
}
