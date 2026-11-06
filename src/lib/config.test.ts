import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://trace:trace@localhost:5433/trace",
  SESSION_SECRET: "x".repeat(32),
  STRIPE_SECRET_KEY: "sk_test_config",
  STRIPE_WEBHOOK_SECRET: "whsec_config",
};

describe("parseConfig", () => {
  it("accepts a minimal environment and treats empty optional provider keys as unset", () => {
    const config = parseConfig({ ...valid, INCREASE_API_KEY: "" });
    expect(config.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(config.STRIPE_SECRET_KEY).toBe("sk_test_config");
    expect(config.INCREASE_API_KEY).toBeUndefined();
  });

  it("requires the Stripe keys, counting empty as missing", () => {
    expect(() => parseConfig({ ...valid, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: undefined })).toThrow(
      "Invalid environment: STRIPE_SECRET_KEY is required; STRIPE_WEBHOOK_SECRET is required",
    );
  });

  it("refuses a live Stripe key without echoing it", () => {
    let message = "";
    try {
      parseConfig({ ...valid, STRIPE_SECRET_KEY: "sk_live_realmoney" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Invalid environment: STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_… or rk_test_…)");
    expect(message).not.toContain("realmoney");
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
