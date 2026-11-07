import { DURATION_BUCKETS_MS, type RouteLatency } from "../../services/latency";

const ms = (value: number | null) => (value === null ? "—" : `${value} ms`);

function maxBucketText(maxBucket: string | null): string {
  if (maxBucket === null) return "—";
  return maxBucket === "+Inf" ? `> ${DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1]} ms` : `≤ ${maxBucket} ms`;
}

/** API request durations per route, from the http_request_duration_ms histogram. */
export function LatencyTable({ routes }: { routes: readonly RouteLatency[] }) {
  return (
    <section className="overflow-hidden rounded-md border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold">API latency (server side)</h2>
        <p className="text-xs text-neutral-500">
          Time inside the app, from the request reaching the route handler to its response; p50 and p95 are estimated from buckets.
          Your total time also includes the network to Sydney (ap-southeast-2) and back; the <code>Server-Timing: app;dur=…</code>{" "}
          response header shows the app&apos;s share of each request in browser devtools.
        </p>
      </div>
      {routes.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-600">No API requests timed yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Route</th>
              <th className="px-4 py-2 text-right font-medium">Requests</th>
              <th className="px-4 py-2 text-right font-medium">p50</th>
              <th className="px-4 py-2 text-right font-medium">p95</th>
              <th className="px-4 py-2 text-right font-medium">Slowest</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {routes.map((r) => (
              <tr key={r.route}>
                <td className="px-4 py-2 font-mono text-xs">{r.route}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{r.count}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{ms(r.p50Ms)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{ms(r.p95Ms)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{maxBucketText(r.maxBucket)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
