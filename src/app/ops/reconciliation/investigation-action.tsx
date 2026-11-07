import Link from "next/link";
import { ActionButton } from "./action-button";

/** An exception's investigation: a link if one exists, else "Open investigation" (POST /api/ops/investigations), which then opens it. */
export function InvestigationAction({ recordId, investigationId }: { recordId: string; investigationId: string | null }) {
  if (investigationId) {
    return (
      <Link href={`/ops/investigations/${investigationId}`} className="text-xs font-medium text-neutral-800 underline">
        Investigation →
      </Link>
    );
  }
  return (
    <ActionButton
      url="/api/ops/investigations"
      body={{ recordId }}
      label="Open investigation"
      pendingLabel="Opening…"
      tone="light"
      open="investigation"
    />
  );
}
