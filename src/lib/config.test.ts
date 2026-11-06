import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://trace:trace@localhost:5433/trace",
  SESSION_SECRET: "x".repeat(32),
};

describe("parseConfig", () => {
  it("accepts a minimal environment and treats empty provider keys as unset", () => {
    const config = parseConfig({ ...valid, STRIPE_SECRET_KEY: "" });
    expect(config.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("names the missing variable", () => {
    expect(() => parseConfig({ SESSION_SECRET: valid.SESSION_SECRET })).toThrow(
      "Invalid environment: DATABASE_URL is required",
    );
  });

  it("explains an invalid value without echoing it", () => {
    let message = "";
    try {
      parseConfig({ ...valid, SESSION_SECRET: "short-secret" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Invalid environment: SESSION_SECRET must be at least 32 characters");
    expect(message).not.toContain("short-secret");
  });
});
