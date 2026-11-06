import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleLogout } from "../handle-auth";

export async function POST(request: Request): Promise<Response> {
  return handleLogout({ db: apiDeps().db, logger }, request);
}
