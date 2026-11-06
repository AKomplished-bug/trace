import { logger } from "../../../../../lib/logger";
import { apiDeps } from "../../../deps";
import { handleCardSimulation } from "../../handle-card-simulation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { db, increase } = apiDeps();
  return handleCardSimulation({ db, provider: increase, logger }, "settle", request, await params);
}
