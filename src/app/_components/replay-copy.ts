import type { EdgeKind, ExplanationKey, GraphNode } from "../../domain/replay";
import { formatCents } from "../../lib/money";
import type { TransactionReplay } from "../../services/replay-queries";
import { ENTRY_LABELS, providerLabel, TYPE_LABELS, type TransactionType } from "./labels";

/** What a replay step did to the two balances, in plain words (spec §11: explanatory, not decorative). */
export const EFFECT_COPY: Record<ExplanationKey, string> = {
  hold_created: "Available drops by the held amount. The ledger doesn't move: nothing has been paid yet.",
  hold_exceeds_available: "A flag on the hold above it: available went below zero. No further change.",
  ledger_posted: "Money moved: the ledger and available both change by the posted amount.",
  settlement_released_hold:
    "Money moved and the hold was lifted in the same moment: the ledger changes by the settled amount, and available stops counting the hold.",
  hold_released_with_settlement: "Recorded with the settlement above, which already lifted the hold. No further change.",
  hold_released: "The hold is lifted: available goes back up by the held amount. The ledger doesn't move.",
  hold_expired: "The hold lapsed: available goes back up by the held amount. The ledger doesn't move.",
  hold_already_closed: "The hold had already closed, so nothing changes.",
  settled_after_hold_closed: "The hold had already stopped reserving funds, so only the settlement above changed your balances.",
  submitted_to_network: "The payment went out to the ACH network. No money has moved yet, so balances don't change.",
  status_changed: "A status update. Balances don't change.",
};

function holdOf(replay: TransactionReplay) {
  return Object.values(replay.final.holds).find((hold) => hold.transactionId === replay.transactionId);
}

/** "Why the final balance is what it is": one line for the ledger, one for available. */
export function whyFinalBalance(replay: TransactionReplay): string[] {
  const { initial, final } = replay;
  if (replay.steps.length === 0) return [];
  const own = replay.steps.reduce((sum, step) => sum + step.after.ledgerCents - step.before.ledgerCents, 0);
  const other = replay.steps.reduce((sum, step) => sum + (step.otherActivity?.ledgerCents ?? 0), 0);
  const terms = [`${formatCents(initial.ledgerCents)} before this transaction`];
  if (own !== 0) terms.push(`${formatCents(own, { signed: true })} from this transaction`);
  if (other !== 0) terms.push(`${formatCents(other, { signed: true })} from other activity in between`);
  const ledger = `Ledger ${formatCents(final.ledgerCents)} = ${terms.join(" ")}${own === 0 ? " (this transaction moved no money)" : ""}.`;
  const heldCents = final.ledgerCents - final.availableCents;
  const hold = holdOf(replay);
  const holdNote = !hold
    ? ""
    : hold.status === "ACTIVE"
      ? `, including this transaction's ${formatCents(hold.amountCents)} hold, still active`
      : `; this transaction's ${formatCents(hold.amountCents)} hold ${hold.status === "EXPIRED" ? "expired" : "was released"} and no longer counts`;
  const available = `Available ${formatCents(final.availableCents)} = ledger ${formatCents(final.ledgerCents)} − ${formatCents(heldCents)} on hold${holdNote}.`;
  return [ledger, available];
}

const EXTERNAL_SETTLEMENT: Record<TransactionType, string> = {
  FUNDING: "External payment confirmation",
  CARD_PURCHASE: "External settlement",
  CARD_REVERSAL: "External refund",
  OUTBOUND_PAYMENT: "External payment completion",
  PAYMENT_RETURN: "External return",
  ADJUSTMENT: "External record",
};

/** A money graph node's heading and a short line under it. */
export function graphNodeTitle(node: GraphNode, type: TransactionType): { title: string; subtitle: string } {
  switch (node.type) {
    case "external": {
      const title =
        node.role === "authorization"
          ? type === "OUTBOUND_PAYMENT"
            ? "External payment submission"
            : "External authorization"
          : node.role === "settlement"
            ? EXTERNAL_SETTLEMENT[type]
            : node.role === "release"
              ? "External reversal"
              : node.role === "expiration"
                ? "External expiry"
                : "External update";
      return { title, subtitle: `External record · ${providerLabel(node.provider)}` };
    }
    case "hold":
      return { title: "Internal hold", subtitle: `${node.kind === "PENDING_PAYMENT" ? "Payment hold" : "Card hold"} · ${node.status.toLowerCase()}` };
    case "ledger_entry":
      return { title: "Internal ledger entry", subtitle: ENTRY_LABELS[node.entryType] };
    case "balance":
      return { title: "Balance update", subtitle: "Where this left your account" };
    case "transaction":
      return {
        title: node.relation === "original" ? `Original: ${TYPE_LABELS[node.transactionType]}` : `Follow-up: ${TYPE_LABELS[node.transactionType]}`,
        subtitle: "Linked transaction",
      };
  }
}

export const EDGE_COPY: Record<EdgeKind, string> = {
  created: "creates",
  closed_by: "closed by",
  posted: "posts",
  updated: "updates",
  reserves: "reserves funds in",
  restored: "gives funds back to",
  original_of: "is the original of",
  followed_by: "followed by",
};

/** Where a node links: the timeline step, ledger entry or linked transaction behind it. */
export function graphNodeHref(node: GraphNode): string | null {
  if (node.type === "transaction") return `/transactions/${node.transactionId}`;
  if (node.type === "ledger_entry") return `#ledger-${node.ledgerEntryId}`;
  return node.stepIds[0] ? `#step-${node.stepIds[0]}` : null;
}
