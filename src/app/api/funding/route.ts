import { logger } from "../../../lib/logger";
import { apiDeps } from "../deps";
import { handleFunding } from "./handle-funding";

export async function POST(request: Request): Promise<Response> {
  const { db, stripe } = apiDeps();
  return handleFunding({ db, provider: stripe, logger }, request);
}
