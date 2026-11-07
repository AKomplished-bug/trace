import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata = { title: "Sign in · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Codes the login form post redirects back with (api/auth/handle-auth.ts); anything else shows nothing.
const ERRORS: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  too_many_attempts: "Too many sign-in attempts. Try again later.",
  login_unavailable: "Sign-in is unavailable right now. Try again shortly.",
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).error;
  const error = ERRORS[Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")];
  return (
    <main id="main" className="flex min-h-svh flex-col items-center justify-center gap-6 px-4 py-12">
      <p className="text-lg font-semibold tracking-tight">Trace</p>
      <Card className="w-full max-w-sm gap-5 py-6">
        <CardHeader className="px-6">
          <CardTitle>
            <h1 className="text-lg font-semibold">Sign in</h1>
          </CardTitle>
          <CardDescription>A sandbox: the business, its money and the providers are all test data.</CardDescription>
        </CardHeader>
        <CardContent className="px-6">
          <form method="post" action="/api/auth/login" className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="username" className="h-10" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required autoComplete="current-password" className="h-10" />
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-danger-line/70 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" className="h-10 w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
