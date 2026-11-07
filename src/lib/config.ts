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

// Seeded users' passwords (db:seed only). Empty counts as unset.
const seedPassword = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(12, "must be at least 12 characters").optional(),
);
const seedFields = {
  NODE_ENV: z.string().optional(),
  TRACE_OWNER_PASSWORD: seedPassword,
  TRACE_OPS_PASSWORD: seedPassword,
};

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
const seedSchema = z.object({ ...databaseFields, ...seedFields }).superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  for (const name of ["TRACE_OWNER_PASSWORD", "TRACE_OPS_PASSWORD"] as const) {
    if (env[name] === undefined) ctx.addIssue({ code: "custom", path: [name], message: "is required in production" });
  }
});

export type Config = z.infer<typeof schema>;
export type SessionConfig = z.infer<typeof sessionSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type SeedConfig = z.infer<typeof seedSchema>;

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

/** DATABASE_URL and the seeded users' passwords, for db:seed; both passwords required in production. */
export function parseSeedConfig(env: Record<string, string | undefined>): SeedConfig {
  return parseWith(seedSchema, env);
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
