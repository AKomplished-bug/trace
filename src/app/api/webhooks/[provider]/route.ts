import { logger } from "../../../../lib/logger";
import { apiDeps } from "../../deps";
import { handleWebhook } from "../handle-webhook";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await params;
  return handleWebhook({ ...apiDeps(), logger }, provider, request);
}
