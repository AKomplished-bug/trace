import { cn } from "@/lib/utils";
import { amountView, STATUS_LABELS } from "./labels";
import { Money } from "./money";

type Props = { t: Parameters<typeof amountView>[0]; className?: string };

/** A transaction's amount, signed only if it posted to the ledger; see amountView. */
export function TransactionAmount({ t, className = "" }: Props) {
  const view = amountView(t);
  switch (view.kind) {
    case "posted":
      return <Money cents={view.cents} signed className={className} />;
    case "held":
      return (
        <span className={cn("inline-flex flex-col items-end leading-tight", className)}>
          <Money cents={view.cents} className="text-pending" />
          <span className="text-xs font-normal text-pending">On hold</span>
        </span>
      );
    case "void":
      return (
        <span className={cn("inline-flex flex-col items-end leading-tight", className)}>
          <Money cents={view.cents} className="text-muted-foreground line-through" />
          <span className="text-xs font-normal text-muted-foreground">{STATUS_LABELS[view.status]}, no money moved</span>
        </span>
      );
    case "pending":
      return (
        <span className={cn("inline-flex flex-col items-end leading-tight", className)}>
          <Money cents={view.cents} className="text-muted-foreground" />
          <span className="text-xs font-normal text-muted-foreground">Not moved yet</span>
        </span>
      );
  }
}
