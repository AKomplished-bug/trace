import pino from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetDb } from "../../db/test-helpers";
import { logger } from "../../lib/logger";
import { flushCounters, readCounters } from "../../services/metrics";
import { withRequestLog } from "./handler";

const { pool, db } = createTestDb();
const route = "GET /api/test";

/** A logger that keeps every line it writes. */
function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line)) }) };
}

async function histogram() {
  await flushCounters(db, logger);
  return (await readCounters(db)).filter((c) => c.name.startsWith("http_request_duration_ms"));
}

beforeEach(async () => {
  await flushCounters(db, logger);
  await resetDb(db);
});
afterAll(() => pool.end());

describe("withRequestLog timing", () => {
  it("logs duration_ms, sends Server-Timing and counts the request in its buckets", async () => {
    const { lines, logger: log } = capturingLogger();
    const response = await withRequestLog({ logger: log }, route, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ ok: true });
    });

    const [line] = lines;
    expect(line.msg).toBe("request handled");
    expect(line.duration_ms).toEqual(expect.any(Number));
    const duration = line.duration_ms as number;
    expect(duration).toBeGreaterThanOrEqual(29);
    expect(response.headers.get("server-timing")).toBe(`app;dur=${duration}`);

    const counters = await histogram();
    const buckets = Object.fromEntries(counters.filter((c) => c.name.endsWith("_bucket")).map((c) => [c.labels.le, c.value]));
    expect(buckets).toEqual(
      Object.fromEntries(["50", "100", "250", "500", "1000", "2500", "+Inf"].filter((le) => le === "+Inf" || duration <= Number(le)).map((le) => [le, 1])),
    );
    expect(counters.find((c) => c.name === "http_request_duration_ms_count")).toMatchObject({ labels: { route }, value: 1 });
    expect(counters.find((c) => c.name === "http_request_duration_ms_sum")).toMatchObject({ labels: { route }, value: duration });
    for (const c of counters) expect(Object.keys(c.labels).sort()).toEqual(c.name.endsWith("_bucket") ? ["le", "route"] : ["route"]);
  });

  it("times a failed request too, and a response whose headers are immutable", async () => {
    const { lines, logger: log } = capturingLogger();
    const failed = await withRequestLog({ logger: log }, route, async () => {
      throw new Error("boom");
    });
    expect(failed.status).toBe(500);
    expect(failed.headers.get("server-timing")).toMatch(/^app;dur=\d+$/);
    expect(lines[0]).toMatchObject({ msg: "request failed", duration_ms: expect.any(Number) });

    const redirect = await withRequestLog({ logger: log }, route, async () => Response.redirect("http://localhost/login", 303));
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("http://localhost/login");
    expect(redirect.headers.get("server-timing")).toMatch(/^app;dur=\d+$/);

    expect((await histogram()).find((c) => c.name === "http_request_duration_ms_count")?.value).toBe(2);
  });
});
