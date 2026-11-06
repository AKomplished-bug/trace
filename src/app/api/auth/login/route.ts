import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleLogin } from "../handle-auth";

export async function POST(request: Request): Promise<Response> {
  return handleLogin({ db: apiDeps().db, logger }, request);
}
