import { describe, expect, it } from "vitest";
import { safeErrorForLog, safeErrorMessage } from "./errors";

function databaseError(fields: Record<string, string>) {
  return Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
    severity: "ERROR",
    detail: "Key (email)=(owner@acme.test) already exists.",
    ...fields,
  });
}

class QueryWrapper extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    override readonly cause: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`);
  }
}

describe("safeErrorMessage", () => {
  it("keeps our error class and message", () => {
    expect(safeErrorMessage(new TypeError("settlement before authorization"))).toBe(
      "TypeError: settlement before authorization",
    );
  });

  it("reduces database errors to SQLSTATE and names, without detail or values", () => {
    const error = databaseError({ code: "23505", constraint: "users_email_unique", table: "users" });
    const message = safeErrorMessage(error);
    expect(message).toBe("DatabaseError 23505 (unique violation) constraint=users_email_unique table=users");
    expect(message).not.toContain("owner@acme.test");
  });

  it("unwraps query wrappers without exposing the SQL params", () => {
    const wrapped = new QueryWrapper("insert into users ...", ["owner@acme.test"], databaseError({ code: "23505" }));
    expect(safeErrorMessage(wrapped)).toBe("DatabaseError 23505 (unique violation)");
    expect(safeErrorMessage(new QueryWrapper("select 1", ["secret"], undefined))).toBe("Database query failed");
    expect(JSON.stringify(safeErrorForLog(wrapped))).not.toContain("owner@acme.test");
  });

  it("handles non-errors", () => {
    expect(safeErrorMessage("boom")).toBe("Unknown error");
  });
});
