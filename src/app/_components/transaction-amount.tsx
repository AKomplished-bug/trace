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
        <span className={className}>
          <Money cents={view.cents} className="text-amber-800" />
          <span className="ml-1 align-middle text-xs font-normal text-amber-700">on hold</span>
        </span>
      );
    case "void":
      return (
        <span className={className}>
          <Money cents={view.cents} className="text-neutral-400 line-through" />
          <span className="ml-1 align-middle text-xs font-normal text-neutral-500">{STATUS_LABELS[view.status].toLowerCase()}</span>
        </span>
      );
    case "pending":
      return (
        <span className={className}>
          <Money cents={view.cents} className="text-neutral-500" />
          <span className="ml-1 align-middle text-xs font-normal text-neutral-500">not moved yet</span>
        </span>
      );
  }
}
