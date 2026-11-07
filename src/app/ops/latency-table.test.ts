import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { latencyByRoute } from "../../services/latency";
import { LatencyTable } from "./latency-table";

const BOUNDS = ["5", "10", "25", "50", "100", "250", "500", "1000", "2500", "+Inf"];
const render = (routes: ReturnType<typeof latencyByRoute>) => renderToStaticMarkup(createElement(LatencyTable, { routes }));

describe("Ops API latency table", () => {
  it("renders route, count, p50, p95 and the slowest bucket, labelled as time inside the app", () => {
    const route = "GET /api/account/balance";
    const cumulative = [1, 3, 3, 4, 4, 4, 5, 5, 5, 5];
    const html = render(
      latencyByRoute([
        ...BOUNDS.map((le, i) => ({ name: "http_request_duration_ms_bucket", labels: { route, le }, value: cumulative[i] })),
        { name: "http_request_duration_ms_count", labels: { route }, value: 5 },
        { name: "http_request_duration_ms_sum", labels: { route }, value: 358 },
      ]),
    );
    expect(html).toContain("API latency (server side)");
    expect(html).toContain("Time inside the app");
    expect(html).toContain("network to Sydney");
    expect(html).toContain("Server-Timing: app;dur=…");
    expect(html).toMatch(new RegExp(`${route}</td>.*>5</td>.*>9 ms</td>.*>438 ms</td>.*>≤ 500 ms</td>`));
  });

  it("says nothing was timed when there are no requests", () => {
    expect(render([])).toContain("No API requests timed yet.");
  });
});
