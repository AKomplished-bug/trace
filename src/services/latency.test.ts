import { describe, expect, it } from "vitest";
import { estimatePercentile, latencyByRoute } from "./latency";

const route = "GET /api/account/balance";
const BOUNDS = ["5", "10", "25", "50", "100", "250", "500", "1000", "2500", "+Inf"];

/** readCounters rows for one route, from cumulative counts in bucket order. */
function rows(cumulative: number[], sum: number) {
  return [
    ...BOUNDS.map((le, i) => ({ name: "http_request_duration_ms_bucket", labels: { route, le }, value: cumulative[i] })),
    { name: "http_request_duration_ms_count", labels: { route }, value: cumulative[cumulative.length - 1] },
    { name: "http_request_duration_ms_sum", labels: { route }, value: sum },
  ];
}

describe("estimatePercentile", () => {
  it("interpolates linearly inside the bucket the rank falls in", () => {
    // 10 requests: 4 in (0, 5], 4 in (5, 10], 2 in (100, 250].
    const cumulative = [4, 8, 8, 8, 8, 10, 10, 10, 10, 10];
    expect(estimatePercentile(cumulative, 10, 0.5)).toBe(6); // rank 5: 1/4 of the way through (5, 10]
    expect(estimatePercentile(cumulative, 10, 0.95)).toBe(213); // rank 9.5: 3/4 of the way through (100, 250]
    expect(estimatePercentile(cumulative, 10, 0.4)).toBe(5); // rank 4: the top of the first bucket
  });

  it("answers the top finite bound when the rank is in +Inf, and null with no requests", () => {
    expect(estimatePercentile([0, 0, 0, 0, 0, 0, 0, 0, 1, 4], 4, 0.5)).toBe(2500);
    expect(estimatePercentile(BOUNDS.map(() => 0), 0, 0.5)).toBeNull();
  });
});

describe("latencyByRoute", () => {
  it("groups the histogram per route with p50, p95 and the bucket holding the slowest request", () => {
    const other = "POST /api/payments";
    const summary = latencyByRoute([
      ...rows([4, 8, 8, 8, 8, 10, 10, 10, 10, 10], 400),
      ...rows([0, 0, 0, 0, 0, 0, 0, 0, 1, 2], 4000).map((r) => ({ ...r, labels: { ...r.labels, route: other } })),
      { name: "events_processed_total", labels: { outcome: "processed" }, value: 3 },
    ]);
    expect(summary.map((r) => [r.route, r.count, r.sumMs, r.p50Ms, r.p95Ms, r.maxBucket])).toEqual([
      [other, 2, 4000, 2500, 2500, "+Inf"],
      [route, 10, 400, 6, 213, "250"],
    ]);
    expect(summary[1].buckets).toEqual(BOUNDS.map((le, i) => ({ le, count: [4, 8, 8, 8, 8, 10, 10, 10, 10, 10][i] })));
  });

  it("is empty when nothing was timed", () => {
    expect(latencyByRoute([{ name: "events_processed_total", labels: {}, value: 1 }])).toEqual([]);
  });
});
