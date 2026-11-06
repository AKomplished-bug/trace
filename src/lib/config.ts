import { z } from "zod";

// Empty strings (e.g. `STRIPE_SECRET_KEY=` in .env) count as unset.
const optionalSecret = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const schema = z.object({
  DATABASE_URL: z.url(),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Test mode only: a live key would move real money.
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_test_/, "must be a Stripe test-mode key (sk_test_… or rk_test_…)"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_", "must be a Stripe webhook signing secret (whsec_…)"),
  // Optional until the Increase integration lands.
  INCREASE_API_KEY: optionalSecret,
  INCREASE_WEBHOOK_SECRET: optionalSecret,
});

export type Config = z.infer<typeof schema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".");
    return env[name] === undefined || env[name] === "" ? `${name} is required` : `${name} ${issue.message}`;
  });
  throw new Error(`Invalid environment: ${problems.join("; ")}`);
}

let cached: Config | undefined;

export function config(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}
