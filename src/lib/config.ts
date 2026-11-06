import { z } from "zod";

/** The placeholder in .env.example; fine locally, refused in production. */
export const EXAMPLE_SESSION_SECRET = "local-dev-session-secret-change-me-0000";

const databaseFields = { DATABASE_URL: z.url() };
const sessionFields = {
  NODE_ENV: z.string().optional(),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
};

function noExampleSecretInProduction(env: { NODE_ENV?: string; SESSION_SECRET: string }, ctx: z.RefinementCtx) {
  if (env.NODE_ENV === "production" && env.SESSION_SECRET === EXAMPLE_SESSION_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["SESSION_SECRET"],
      message: "is the .env.example placeholder; set a random value of at least 32 characters in production",
    });
  }
}

const schema = z
  .object({
    ...databaseFields,
    ...sessionFields,
    // Test mode only: a live key would move real money.
    STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_test_/, "must be a Stripe test-mode key (sk_test_… or rk_test_…)"),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_", "must be a Stripe webhook signing secret (whsec_…)"),
    // Sandbox only: the adapter always targets sandbox.increase.com, where a production key fails.
    INCREASE_API_KEY: z.string().min(1),
    // The event subscription's shared secret (Standard Webhooks signing key).
    INCREASE_WEBHOOK_SECRET: z.string().min(1),
  })
  .superRefine(noExampleSecretInProduction);
const sessionSchema = z.object(sessionFields).superRefine(noExampleSecretInProduction);
const databaseSchema = z.object(databaseFields);

export type Config = z.infer<typeof schema>;
export type SessionConfig = z.infer<typeof sessionSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;

function parseWith<S extends z.ZodType>(target: S, env: Record<string, string | undefined>): z.infer<S> {
  const result = target.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".");
    return env[name] === undefined || env[name] === "" ? `${name} is required` : `${name} ${issue.message}`;
  });
  throw new Error(`Invalid environment: ${problems.join("; ")}`);
}

/** Everything the web app and worker need; validated at startup (instrumentation.ts, worker). */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return parseWith(schema, env);
}

/** Only what signing and verifying the session cookie needs (the proxy runs on every request). */
export function parseSessionConfig(env: Record<string, string | undefined>): SessionConfig {
  return parseWith(sessionSchema, env);
}

/** Only DATABASE_URL, for scripts (migrate, seed) that never call a provider. */
export function parseDatabaseConfig(env: Record<string, string | undefined>): DatabaseConfig {
  return parseWith(databaseSchema, env);
}

let cached: Config | undefined;
let cachedSession: SessionConfig | undefined;
let cachedDatabase: DatabaseConfig | undefined;

export function config(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}

export function sessionConfig(): SessionConfig {
  cachedSession ??= parseSessionConfig(process.env);
  return cachedSession;
}

export function databaseConfig(): DatabaseConfig {
  cachedDatabase ??= parseDatabaseConfig(process.env);
  return cachedDatabase;
}
