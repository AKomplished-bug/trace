import type { HoldKind, HoldStatus, LedgerEntryType, TransactionType } from "../ledger";
import type { Balances, TraceKind } from "./replay";

/**
 * The money graph (spec §25): what caused what for one transaction — external authorization →
 * internal hold → external settlement → internal ledger entry → balance update — derived from
 * its trace rows, ledger entries, holds and external records. Nodes carry ids of the records
 * behind them so the UI can link to them; never provider payloads.
 */

export interface GraphStep {
  id: string;
  accountSeq: number;
  kind: TraceKind;
  /** Provider element behind the step (authorization, settlement, reversal … id). */
  providerRef: string | null;
  /** Our external_events id. */
  eventId: string | null;
  ledgerEntryId: string | null;
  recorded: Balances;
}

export interface GraphInput {
  transaction: { id: string; type: TransactionType; provider: string | null };
  /** In account_seq order. */
  steps: ReadonlyArray<GraphStep>;
  ledgerEntries: ReadonlyArray<{ id: string; entryType: LedgerEntryType; amountCents: number }>;
  holds: ReadonlyArray<{ id: string; kind: HoldKind; status: HoldStatus; amountCents: number }>;
  /** External events behind the steps: metadata only. */
  externalEvents: ReadonlyArray<{ id: string; provider: string; externalEventId: string; eventType: string }>;
  related: ReadonlyArray<{ id: string; type: TransactionType; relation: "original" | "follow_up" }>;
}

/** What an external record did, from the first step it caused. */
export type ExternalRole = "authorization" | "settlement" | "release" | "expiration" | "status_update";

export type GraphNode =
  | {
      id: string;
      type: "external";
      role: ExternalRole;
      provider: string | null;
      providerRef: string | null;
      /** Our external_events ids and the provider's event ids for them. */
      eventIds: string[];
      externalEventIds: string[];
      stepIds: string[];
    }
  | { id: string; type: "hold"; holdId: string; kind: HoldKind; status: HoldStatus; amountCents: number; stepIds: string[] }
  | { id: string; type: "ledger_entry"; ledgerEntryId: string; entryType: LedgerEntryType; amountCents: number; stepIds: string[] }
  | { id: string; type: "balance"; ledgerCents: number; availableCents: number; stepIds: string[] }
  | { id: string; type: "transaction"; transactionId: string; transactionType: TransactionType; relation: "original" | "follow_up"; stepIds: string[] };

export type EdgeKind = "created" | "closed_by" | "posted" | "updated" | "reserves" | "restored" | "original_of" | "followed_by";

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface MoneyGraph {
  /** In causal order: first appearance in the trace, balance after its causes, linked transactions at the ends. */
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const ROLE: Record<TraceKind, ExternalRole> = {
  HOLD_CREATED: "authorization",
  HOLD_EXCEEDS_AVAILABLE: "authorization",
  LEDGER_POSTED: "settlement",
  SETTLED_AFTER_HOLD_CLOSED: "settlement",
  HOLD_RELEASED: "release",
  HOLD_EXPIRED: "expiration",
  STATUS_CHANGED: "status_update",
};

const CLOSES_HOLD: ReadonlySet<TraceKind> = new Set(["HOLD_RELEASED", "HOLD_EXPIRED", "SETTLED_AFTER_HOLD_CLOSED"]);

export function moneyGraph(input: GraphInput): MoneyGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const link = (from: string | undefined, to: string | undefined, kind: EdgeKind) => {
    if (from && to && from !== to) edges.set(`${from}>${to}>${kind}`, { from, to, kind });
  };
  const eventsById = new Map(input.externalEvents.map((event) => [event.id, event]));
  const hold = input.holds[0];
  const holdNodeId = hold ? `hold:${hold.id}` : undefined;
  const entries = new Map(input.ledgerEntries.map((entry) => [entry.id, entry]));
  const original = input.related.filter((r) => r.relation === "original");
  const followUps = input.related.filter((r) => r.relation === "follow_up");

  for (const r of original) {
    nodes.set(`transaction:${r.id}`, { id: `transaction:${r.id}`, type: "transaction", transactionId: r.id, transactionType: r.type, relation: r.relation, stepIds: [] });
  }

  // One external node per provider element (or per external event when a step has no element id).
  // A status-only step adds to a known element's node but doesn't create one.
  const externalFor = (step: GraphStep): string | undefined => {
    const key = step.providerRef ?? step.eventId;
    if (!key) return undefined;
    const id = `external:${key}`;
    const existing = nodes.get(id);
    if (!existing && step.kind === "STATUS_CHANGED") return undefined;
    const event = step.eventId ? eventsById.get(step.eventId) : undefined;
    const node =
      existing?.type === "external"
        ? existing
        : { id, type: "external" as const, role: ROLE[step.kind], provider: input.transaction.provider, providerRef: step.providerRef, eventIds: [], externalEventIds: [], stepIds: [] };
    if (!node.stepIds.includes(step.id)) node.stepIds.push(step.id);
    if (event && !node.eventIds.includes(event.id)) {
      node.eventIds.push(event.id);
      node.externalEventIds.push(event.externalEventId);
      node.provider = event.provider;
    }
    nodes.set(id, node);
    return id;
  };

  let postedLedger = false;
  for (const step of input.steps) {
    const external = externalFor(step);
    if (step.kind === "HOLD_CREATED" && hold && holdNodeId) {
      nodes.set(holdNodeId, { id: holdNodeId, type: "hold", holdId: hold.id, kind: hold.kind, status: hold.status, amountCents: hold.amountCents, stepIds: [step.id] });
      link(external, holdNodeId, "created");
    } else if (CLOSES_HOLD.has(step.kind) && holdNodeId) {
      const holdNode = nodes.get(holdNodeId);
      if (holdNode && !holdNode.stepIds.includes(step.id)) holdNode.stepIds.push(step.id);
      link(holdNodeId, external, "closed_by");
    } else if (step.kind === "LEDGER_POSTED" && step.ledgerEntryId) {
      const entry = entries.get(step.ledgerEntryId);
      if (entry) {
        const id = `ledger:${entry.id}`;
        nodes.set(id, { id, type: "ledger_entry", ledgerEntryId: entry.id, entryType: entry.entryType, amountCents: entry.amountCents, stepIds: [step.id] });
        link(external, id, "posted");
        postedLedger = true;
      }
    }
  }

  const last = input.steps.at(-1);
  if (last) {
    nodes.set("balance", { id: "balance", type: "balance", ledgerCents: last.recorded.ledgerCents, availableCents: last.recorded.availableCents, stepIds: [last.id] });
    for (const node of nodes.values()) if (node.type === "ledger_entry") link(node.id, "balance", "updated");
    if (hold && holdNodeId && nodes.has(holdNodeId)) {
      if (hold.status === "ACTIVE") link(holdNodeId, "balance", "reserves");
      else if (!postedLedger) {
        // Closed without moving money (void, expiry): the closing record gave the funds back.
        const closer = [...edges.values()].find((edge) => edge.from === holdNodeId && edge.kind === "closed_by")?.to;
        link(closer ?? holdNodeId, "balance", "restored");
      }
    }
  }

  const first = [...nodes.values()].find((node) => node.type !== "transaction");
  for (const r of original) link(`transaction:${r.id}`, first?.id, "original_of");
  for (const r of followUps) {
    const id = `transaction:${r.id}`;
    nodes.set(id, { id, type: "transaction", transactionId: r.id, transactionType: r.type, relation: r.relation, stepIds: [] });
    link(last ? "balance" : first?.id, id, "followed_by");
  }

  // Keep the balance after everything that feeds it, follow-ups last.
  const ordered = [...nodes.values()];
  const rank = (node: GraphNode) => (node.type === "transaction" ? (node.relation === "original" ? 0 : 3) : node.type === "balance" ? 2 : 1);
  ordered.sort((a, b) => rank(a) - rank(b));
  return { nodes: ordered, edges: [...edges.values()] };
}
