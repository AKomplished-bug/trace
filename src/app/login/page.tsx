import { connection } from "next/server";
import { apiDeps } from "../api/deps";
import { listUsers } from "../../services/users";
import { Tag } from "../_components/status-badge";

export const metadata = { title: "Sign in · Trace" };

export default async function LoginPage() {
  await connection();
  const users = await listUsers(apiDeps().db);
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-16">
      <p className="font-mono text-sm font-semibold tracking-tight">
        trace<span className="text-emerald-600">_</span>
      </p>
      <h1 className="mt-6 text-xl font-semibold tracking-tight">Sign in to the sandbox</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Pick a demo user. There are no passwords here: the business, its money and the providers are all test data.
      </p>
      {users.length === 0 ? (
        <p className="mt-6 rounded border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
          No demo users yet. Run <code className="font-mono">npm run db:seed</code> and reload.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 overflow-hidden rounded-md border border-neutral-200 bg-white">
          {users.map((user) => (
            <li key={user.id}>
              <form method="post" action="/api/auth/login">
                <input type="hidden" name="userId" value={user.id} />
                <button type="submit" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{user.name}</span>
                    <span className="block truncate font-mono text-xs text-neutral-500">{user.email}</span>
                  </span>
                  <span className="text-right text-xs text-neutral-500">
                    <Tag tone={user.role === "OPS" ? "amber" : "neutral"}>{user.role === "OPS" ? "Ops" : "Owner"}</Tag>
                    <span className="mt-1 block">{user.businessName ?? "Trace operations"}</span>
                  </span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
