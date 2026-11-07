import { countOutcome } from "./metrics";

/**
 * Request duration as a bucket histogram in the outcome counters (no new store):
 * `http_request_duration_ms_bucket{route,le}` (cumulative: every bucket whose bound is ≥ the
 * duration), `http_request_duration_ms_count{route}` and `http_request_duration_ms_sum{route}`.
 * `route` is the fixed route name from withRequestLog, never a raw path. Time inside the app only.
 */

export const DURATION_METRIC = "http_request_duration_ms";
export const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;
const INF = "+Inf";
const BUCKET = `${DURATION_METRIC}_bucket`;
const COUNT = `${DURATION_METRIC}_count`;
const SUM = `${DURATION_METRIC}_sum`;

/** Buffers one request's duration (whole ms); like countOutcome, no I/O and never throws. */
export function recordRequestDuration(route: string, durationMs: number): void {
  for (const le of DURATION_BUCKETS_MS) if (durationMs <= le) countOutcome(BUCKET, { route, le: String(le) });
  countOutcome(BUCKET, { route, le: INF });
  countOutcome(COUNT, { route });
  countOutcome(SUM, { route }, durationMs);
}

export function isDurationCounter(name: string): boolean {
  return name === BUCKET || name === COUNT || name === SUM;
}

export interface RouteLatency {
  route: string;
  count: number;
  sumMs: number;
  /** Cumulative counts per bucket bound, "+Inf" last. */
  buckets: { le: string; count: number }[];
  /** Estimated from the buckets (linear within a bucket); capped at the top finite bound. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** The smallest bucket holding every request: the slowest one took at most this long. */
  maxBucket: string | null;
}

/**
 * Estimates the q-quantile (0–1) from cumulative bucket counts the way Prometheus's
 * histogram_quantile does: find the bucket the rank falls in and interpolate linearly between its
 * bounds. A rank in the +Inf bucket answers the top finite bound. Null when nothing was counted.
 */
export function estimatePercentile(cumulative: readonly number[], total: number, q: number): number | null {
  if (total <= 0) return null;
  const rank = q * total;
  let below = 0;
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
    const inBucket = Math.max(cumulative[i] ?? 0, below);
    if (inBucket >= rank) {
      const lower = i === 0 ? 0 : DURATION_BUCKETS_MS[i - 1];
      const upper = DURATION_BUCKETS_MS[i];
      const share = inBucket === below ? 1 : (rank - below) / (inBucket - below);
      return Math.round(lower + (upper - lower) * share);
    }
    below = inBucket;
  }
  return DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1];
}

/** Per-route histograms from readCounters' rows, slowest p95 first. */
export function latencyByRoute(counters: readonly { name: string; labels: Record<string, string>; value: number }[]): RouteLatency[] {
  const routes = new Map<string, { count: number; sum: number; buckets: Map<string, number> }>();
  const routeOf = (route: string) => {
    let entry = routes.get(route);
    if (!entry) routes.set(route, (entry = { count: 0, sum: 0, buckets: new Map() }));
    return entry;
  };
  for (const { name, labels, value } of counters) {
    if (!isDurationCounter(name) || !labels.route) continue;
    const entry = routeOf(labels.route);
    if (name === COUNT) entry.count = value;
    else if (name === SUM) entry.sum = value;
    else if (labels.le) entry.buckets.set(labels.le, value);
  }
  return [...routes.entries()]
    .map(([route, { count, sum, buckets }]) => {
      const bounds = [...DURATION_BUCKETS_MS.map(String), INF];
      const cumulative = bounds.map((le) => buckets.get(le) ?? 0);
      const maxIndex = count > 0 ? cumulative.findIndex((n) => n >= count) : -1;
      return {
        route,
        count,
        sumMs: sum,
        buckets: bounds.map((le, i) => ({ le, count: cumulative[i] })),
        p50Ms: estimatePercentile(cumulative, count, 0.5),
        p95Ms: estimatePercentile(cumulative, count, 0.95),
        maxBucket: maxIndex === -1 ? null : bounds[maxIndex],
      };
    })
    .sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || a.route.localeCompare(b.route));
}
