export const metadata = { title: "Sign in · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Codes the login form post redirects back with (api/auth/handle-auth.ts); anything else shows nothing.
const ERRORS: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  too_many_attempts: "Too many sign-in attempts. Try again later.",
  login_unavailable: "Sign-in is unavailable right now. Try again shortly.",
};

const input = "mt-1 block w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm";

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).error;
  const error = ERRORS[Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")];
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-16">
      <p className="font-mono text-sm font-semibold tracking-tight">
        trace<span className="text-emerald-600">_</span>
      </p>
      <h1 className="mt-6 text-xl font-semibold tracking-tight">Sign in to the sandbox</h1>
      <p className="mt-2 text-sm text-neutral-600">The business, its money and the providers are all test data.</p>
      <form method="post" action="/api/auth/login" className="mt-6 grid gap-3">
        <label className="text-xs text-neutral-600">
          Email
          <input name="email" type="email" required autoComplete="username" className={input} />
        </label>
        <label className="text-xs text-neutral-600">
          Password
          <input name="password" type="password" required autoComplete="current-password" className={input} />
        </label>
        {error && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <button type="submit" className="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700">
          Sign in
        </button>
      </form>
    </main>
  );
}
