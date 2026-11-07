import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DURATION_BUCKETS_MS, type RouteLatency } from "../../services/latency";
import { Panel } from "../_components/page-parts";

const ms = (value: number | null) => (value === null ? "—" : `${value} ms`);

function maxBucketText(maxBucket: string | null): string {
  if (maxBucket === null) return "—";
  return maxBucket === "+Inf" ? `> ${DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1]} ms` : `≤ ${maxBucket} ms`;
}

/** API request durations per route, from the http_request_duration_ms histogram. */
export function LatencyTable({ routes }: { routes: readonly RouteLatency[] }) {
  return (
    <Panel
      title="API latency (server side)"
      description={
        <>
          Time inside the app, from the request reaching the route handler to its response; p50 and p95 are estimated from buckets. Your total time also
          includes the network to Sydney (ap-southeast-2) and back; the <code className="font-mono">Server-Timing: app;dur=…</code> response header shows the
          app&apos;s share of each request in browser devtools.
        </>
      }
      flush
    >
      {routes.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No API requests timed yet.</p>
      ) : (
        <Table>
          <caption className="sr-only">API latency per route</caption>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4 text-xs text-muted-foreground">Route</TableHead>
              <TableHead className="px-4 text-right text-xs text-muted-foreground">Requests</TableHead>
              <TableHead className="px-4 text-right text-xs text-muted-foreground">p50</TableHead>
              <TableHead className="px-4 text-right text-xs text-muted-foreground">p95</TableHead>
              <TableHead className="px-4 text-right text-xs text-muted-foreground">Slowest</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((r) => (
              <TableRow key={r.route}>
                <TableCell className="px-4 font-mono text-xs break-all whitespace-normal">{r.route}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{r.count}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{ms(r.p50Ms)}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{ms(r.p95Ms)}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{maxBucketText(r.maxBucket)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
