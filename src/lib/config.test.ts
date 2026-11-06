import { describe, expect, it } from "vitest";
import { EXAMPLE_SESSION_SECRET, parseConfig, parseDatabaseConfig, parseSessionConfig } from "./config";

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

  it("refuses the .env.example SESSION_SECRET in production, and short secrets anywhere", () => {
    const production = { ...valid, NODE_ENV: "production", SESSION_SECRET: EXAMPLE_SESSION_SECRET };
    const message =
      "Invalid environment: SESSION_SECRET is the .env.example placeholder; set a random value of at least 32 characters in production";
    expect(() => parseConfig(production)).toThrow(message);
    expect(() => parseSessionConfig(production)).toThrow(message);
    expect(parseSessionConfig({ ...production, NODE_ENV: "development" }).SESSION_SECRET).toBe(EXAMPLE_SESSION_SECRET);
    expect(parseSessionConfig({ ...production, SESSION_SECRET: "r".repeat(40) }).SESSION_SECRET).toBe("r".repeat(40));
    expect(() => parseSessionConfig({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow(
      "Invalid environment: SESSION_SECRET must be at least 32 characters",
    );
  });
});

describe("scoped configs", () => {
  it("validate only what they need, so a missing Stripe key can't break the proxy or scripts", () => {
    expect(parseSessionConfig({ SESSION_SECRET: valid.SESSION_SECRET })).toEqual({ SESSION_SECRET: valid.SESSION_SECRET });
    expect(parseDatabaseConfig({ DATABASE_URL: valid.DATABASE_URL })).toEqual({ DATABASE_URL: valid.DATABASE_URL });
    expect(() => parseSessionConfig({})).toThrow("Invalid environment: SESSION_SECRET is required");
    expect(() => parseDatabaseConfig({})).toThrow("Invalid environment: DATABASE_URL is required");
  });
});
