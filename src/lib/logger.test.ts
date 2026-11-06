import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACT } from "./logger";

describe("logger redaction", () => {
  it("censors bank account details at the top level and one level down", () => {
    const lines: string[] = [];
    const log = pino({ redact: REDACT }, { write: (line: string) => void lines.push(line) });
    log.info({ accountNumber: "987654321", routing_number: "101050001", payment: { account_number: "987654321", routingNumber: "101050001" } }, "x");
    expect(lines[0]).not.toContain("987654321");
    expect(lines[0]).not.toContain("101050001");
    expect(JSON.parse(lines[0])).toMatchObject({ accountNumber: "[redacted]", routing_number: "[redacted]", payment: { account_number: "[redacted]", routingNumber: "[redacted]" } });
  });
});
