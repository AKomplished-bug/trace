import { readCounters } from "../../../../services/metrics";
import { eventCountsByStatus } from "../../../../services/ops-events";
import { outboxBacklog } from "../../../../services/payments";
import { withRequestLog, type HandlerDeps } from "../../handler";
import { requireOps } from "../../session";

/**
 * GET /api/ops/metrics — JSON. `counters`: outcome counters from every process, as of each
 * process's last flush (a few seconds behind). `events` and `payments`: current state, counted
 * from the tables at request time.
 */
export async function handleGetMetrics(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/ops/metrics", async ({ annotate }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const [counters, byStatus, backlog] = await Promise.all([readCounters(deps.db), eventCountsByStatus(deps.db), outboxBacklog(deps.db)]);
    return Response.json({
      counters,
      events: { byStatus },
      payments: { pending: backlog.pending, oldestUnsubmittedAgeSeconds: backlog.oldestAgeSeconds, givenUp: backlog.givenUp },
    });
  });
}
