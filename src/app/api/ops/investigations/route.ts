import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleListInvestigations, handleOpenInvestigation } from "./handle-ops-investigations";

export async function GET(request: Request): Promise<Response> {
  return handleListInvestigations({ db: apiDeps().db, logger }, request);
}

export async function POST(request: Request): Promise<Response> {
  return handleOpenInvestigation({ db: apiDeps().db, logger }, request);
}
