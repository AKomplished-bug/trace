"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { postJson } from "../../_lib/post-json";

/**
 * An exception's investigation: a link if one exists, else "Open investigation" (POST
 * /api/ops/investigations), which then opens it. Opening twice returns the same case, so it needs no confirmation.
 */
export function InvestigationAction({ recordId, investigationId }: { recordId: string; investigationId: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (investigationId) {
    return (
      <Button asChild variant="outline" className="h-8">
        <Link href={`/ops/investigations/${investigationId}`}>View investigation</Link>
      </Button>
    );
  }

  async function openCase() {
    setSending(true);
    setError(null);
    const result = await postJson<{ investigation?: { id?: string } }>("/api/ops/investigations", { recordId });
    setSending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    toast.success("Investigation opened");
    const id = result.data?.investigation?.id;
    if (id) router.push(`/ops/investigations/${id}`);
    else router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="secondary" className="h-8" onClick={openCase} disabled={sending}>
        {sending ? "Opening…" : "Open investigation"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
