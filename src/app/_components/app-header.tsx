import Link from "next/link";
import type { ReactNode } from "react";

/** Top bar shared by the owner and ops shells: wordmark, nav, who's signed in, sign out. */
export function AppHeader({ home, nav, who }: { home: string; nav: ReactNode; who: string }) {
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="bg-neutral-900 px-4 py-1 text-center text-[11px] tracking-wide text-neutral-300">
        Sandbox — fictional business, test providers, no real money.
      </div>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href={home} className="font-mono text-sm font-semibold tracking-tight">
          trace<span className="text-emerald-600">_</span>
        </Link>
        <nav className="flex items-center gap-1">{nav}</nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden truncate text-xs text-neutral-500 sm:inline">{who}</span>
          <form method="post" action="/api/auth/logout">
            <button type="submit" className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
