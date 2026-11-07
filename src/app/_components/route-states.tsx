"use client";

import { RotateCw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** A page-shaped placeholder while a server page loads. */
export function PageSkeleton({ hero }: { hero?: boolean }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {hero && (
        <div className="space-y-4 rounded-xl border bg-card p-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-56" />
          <div className="grid grid-cols-3 gap-4 border-t pt-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border bg-card">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-b-0">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The error boundary's page: what happened, and a retry. No internal details reach the screen. */
export function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-xl border bg-card px-6 py-10 text-center">
      <h1 className="text-lg font-semibold">This page couldn&apos;t load</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Nothing was changed. Try again; if it keeps failing, the problem is on our side.
        {error.digest && <span className="mt-2 block font-mono text-xs">Reference {error.digest}</span>}
      </p>
      <Button onClick={reset} className="mt-5 h-9">
        <RotateCw aria-hidden />
        Try again
      </Button>
    </div>
  );
}
