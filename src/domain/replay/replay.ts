import type { HoldKind, HoldStatus } from "../ledger";

/**
 * Deterministic replay of the money trace (spec §11, §26). Pure: the same ordered trace rows
 * always give the same steps, nothing is read or written. Replay folds `apply` over the rows,
 * starting from a known state, and checks every replayed balance against the one the row
 * recorded — CLAUDE.md's "replayed state == stored state" invariant as a product feature.
 */

/** Kinds of trace rows (`transaction_events.kind`). */
export const TRACE_KINDS = [
  "STATUS_CHANGED",
  "HOLD_CREATED",
  "HOLD_RELEASED",
  "HOLD_EXPIRED",
  "LEDGER_POSTED",
  "SETTLED_AFTER_HOLD_CLOSED",
  "HOLD_EXCEEDS_AVAILABLE",
  "SUBMITTED_TO_NETWORK",
] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export interface Balances {
  ledgerCents: number;
  availableCents: number;
}

export interface ReplayHold {
  id: string;
  transactionId: string;
  kind: HoldKind;
  amountCents: number;
  status: HoldStatus;
}

export interface ReplayState extends Balances {
  /** Holds this replay has seen, by hold id. Holds created before the replay started aren't here. */
  holds: Readonly<Record<string, ReplayHold>>;
  /** Latest status of each transaction the replay has seen, by transaction id. */
  statuses: Readonly<Record<string, string>>;
}

/** One trace row, as replay needs it. */
export interface ReplayEvent {
  /** The trace row id. */
  id: string;
  transactionId: string;
  accountSeq: number;
  kind: TraceKind;
  amountCents: number | null;
  ledgerDeltaCents: number;
  toStatus: string | null;
  /** The transaction's hold (holds are UNIQUE per transaction), if it has one. */
  hold: { id: string; kind: HoldKind } | null;
  /** The balances the row recorded (`ledger_balance_after_cents`, `available_after_cents`). */
  recorded: Balances;
  /**
   * Transaction replays only: the balances recorded by the account's previous trace row
   * (account_seq − 1; zero if this is the account's first). The difference from the replayed
   * state is other transactions' activity in between, not this transaction's.
   */
  recordedBefore?: Balances;
  /**
   * Transaction replays, LEDGER_POSTED only: the amount of the ledger entry the row points at
   * (null if there is none). A row whose delta differs from its entry is a divergence even when
   * the balances add up. Undefined: not checked.
   */
  ledgerEntryCents?: number | null;
}

/**
 * Why a step changed the balances the way it did. The UI maps each key to plain words.
 * - `settlement_released_hold`: ledger posted and the transaction's hold released atomically.
 * - `hold_released_with_settlement`: the trace row for that release; already counted.
 */
export type ExplanationKey =
  | "hold_created"
  | "hold_exceeds_available"
  | "ledger_posted"
  | "settlement_released_hold"
  | "hold_released_with_settlement"
  | "hold_released"
  | "hold_expired"
  | "hold_already_closed"
  | "settled_after_hold_closed"
  | "submitted_to_network"
  | "status_changed";

export interface ReplayStep {
  event: ReplayEvent;
  /** Replayed state before the step, after accounting for `otherActivity`. */
  before: ReplayState;
  after: ReplayState;
  explanation: ExplanationKey;
  /**
   * Transaction replays: how other transactions moved the account since this transaction's
   * previous step (recordedBefore − replayed), when other rows sit in between (a gap in
   * account_seq). Null when nothing else happened in between.
   */
  otherActivity: Balances | null;
  /** The replayed `after` equals what the row recorded (and a posting's delta equals its ledger entry). */
  matches: boolean;
}

export interface Divergence {
  /** Index into `steps`. */
  stepIndex: number;
  /** `balances`: replayed ≠ recorded balances. `ledger_entry`: the row's delta ≠ its ledger entry. */
  reason: "balances" | "ledger_entry";
  eventId: string;
  accountSeq: number;
  replayed: Balances;
  recorded: Balances;
}

export interface ReplayResult {
  initial: ReplayState;
  steps: ReplayStep[];
  final: ReplayState;
  /** Every step's replayed balances equal the recorded ones. */
  consistent: boolean;
  /** The first step where they don't, if any. */
  divergence: Divergence | null;
}

/** A replay event plus what replay learned from its neighbours (see `pairSettlements`). */
export interface AppliedEvent extends ReplayEvent {
  /** LEDGER_POSTED that released this hold in the same database transaction (a settlement). */
  releasesHoldId?: string;
  /** HOLD_RELEASED written by that settlement; its effect is already in the LEDGER_POSTED step. */
  releasedBySettlement?: boolean;
}

export const EMPTY_STATE: ReplayState = { ledgerCents: 0, availableCents: 0, holds: {}, statuses: {} };

const sameBalances = (a: Balances, b: Balances) => a.ledgerCents === b.ledgerCents && a.availableCents === b.availableCents;
const balancesOf = (state: Balances): Balances => ({ ledgerCents: state.ledgerCents, availableCents: state.availableCents });

/**
 * A settlement is one database transaction that posts the ledger entry and releases the hold,
 * then writes LEDGER_POSTED and HOLD_RELEASED with the final balances (CLAUDE.md money rule 5).
 * Both rows are written under the account lock, so they are consecutive on the account
 * (account_seq n, n + 1) and on the transaction, and record the same balances. A post and a
 * release in two separate database transactions also sit at n, n + 1 but record different
 * available balances (the hold still counted at n), so they are not paired and replay as a plain
 * posting and a plain release. Replay applies a paired release with the posting, so the
 * settlement step shows the balances the account actually had; the HOLD_RELEASED step then
 * changes nothing. If a pairing were ever wrong, the replayed balances wouldn't match the
 * recorded ones and the replay would report it, not hide it. (We record no database transaction
 * id per row; see docs/decision-log-full.md, "Replay folds the recorded trace".)
 */
export function pairSettlements(events: ReadonlyArray<ReplayEvent>): AppliedEvent[] {
  const paired: AppliedEvent[] = events.map((event) => ({ ...event }));
  for (let i = 0; i + 1 < paired.length; i++) {
    const posting = paired[i];
    const release = paired[i + 1];
    if (
      posting.kind === "LEDGER_POSTED" &&
      release.kind === "HOLD_RELEASED" &&
      release.transactionId === posting.transactionId &&
      release.accountSeq === posting.accountSeq + 1 &&
      sameBalances(release.recorded, posting.recorded) &&
      release.hold
    ) {
      posting.releasesHoldId = release.hold.id;
      release.releasedBySettlement = true;
    }
  }
  return paired;
}

function withHold(state: ReplayState, hold: ReplayHold, availableChangeCents: number): ReplayState {
  return { ...state, availableCents: state.availableCents + availableChangeCents, holds: { ...state.holds, [hold.id]: hold } };
}

// Closes a hold: if replay saw it ACTIVE, available goes back up by its amount. A hold created
// before the replay started is taken from the row (it records the amount released).
function closeHold(state: ReplayState, event: AppliedEvent, to: HoldStatus): { state: ReplayState; closed: boolean } {
  const id = event.hold?.id ?? `hold:${event.transactionId}`;
  const known = state.holds[id];
  if (known && known.status !== "ACTIVE") return { state, closed: false };
  const hold: ReplayHold = known ?? {
    id,
    transactionId: event.transactionId,
    kind: event.hold?.kind ?? "CARD_AUTHORIZATION",
    amountCents: event.amountCents ?? 0,
    status: "ACTIVE",
  };
  return { state: withHold(state, { ...hold, status: to }, hold.amountCents), closed: true };
}

/**
 * One trace row's effect on the state. Available is carried, not recomputed from `holds`,
 * because a transaction replay doesn't see other transactions' holds; each row moves it by
 * exactly its own effect.
 */
export function apply(state: ReplayState, event: AppliedEvent): { state: ReplayState; explanation: ExplanationKey } {
  switch (event.kind) {
    case "HOLD_CREATED": {
      const amountCents = event.amountCents ?? 0;
      const hold: ReplayHold = {
        id: event.hold?.id ?? `hold:${event.transactionId}`,
        transactionId: event.transactionId,
        kind: event.hold?.kind ?? "CARD_AUTHORIZATION",
        amountCents,
        status: "ACTIVE",
      };
      return { state: withHold(state, hold, -amountCents), explanation: "hold_created" };
    }
    case "LEDGER_POSTED": {
      const posted: ReplayState = {
        ...state,
        ledgerCents: state.ledgerCents + event.ledgerDeltaCents,
        availableCents: state.availableCents + event.ledgerDeltaCents,
      };
      if (event.releasesHoldId === undefined) return { state: posted, explanation: "ledger_posted" };
      const { state: released, closed } = closeHold(posted, event, "RELEASED");
      return { state: released, explanation: closed ? "settlement_released_hold" : "ledger_posted" };
    }
    case "HOLD_RELEASED": {
      if (event.releasedBySettlement) return { state, explanation: "hold_released_with_settlement" };
      const { state: next, closed } = closeHold(state, event, "RELEASED");
      return { state: next, explanation: closed ? "hold_released" : "hold_already_closed" };
    }
    case "HOLD_EXPIRED": {
      const { state: next, closed } = closeHold(state, event, "EXPIRED");
      return { state: next, explanation: closed ? "hold_expired" : "hold_already_closed" };
    }
    case "STATUS_CHANGED":
      return {
        state: event.toStatus === null ? state : { ...state, statuses: { ...state.statuses, [event.transactionId]: event.toStatus } },
        explanation: "status_changed",
      };
    case "SETTLED_AFTER_HOLD_CLOSED":
      return { state, explanation: "settled_after_hold_closed" };
    case "HOLD_EXCEEDS_AVAILABLE":
      return { state, explanation: "hold_exceeds_available" };
    case "SUBMITTED_TO_NETWORK":
      return { state, explanation: "submitted_to_network" };
  }
}

/**
 * `state = initial; for event in events: state = apply(state, event)`, checking each step's
 * balances against the row's. After a mismatch it carries on from the replayed state, so the
 * divergence stays visible instead of being absorbed into the next step.
 */
export function replay(initial: ReplayState, events: ReadonlyArray<ReplayEvent>): ReplayResult {
  const steps: ReplayStep[] = [];
  let state = initial;
  let divergence: Divergence | null = null;
  let previousSeq: number | null = null;
  for (const event of pairSettlements(events)) {
    let otherActivity: Balances | null = null;
    // Only a gap in account_seq can hide other transactions' rows. Consecutive rows carry on from
    // the replayed state, so one bad row flags only its own step.
    const gap = previousSeq === null || event.accountSeq !== previousSeq + 1;
    previousSeq = event.accountSeq;
    if (gap && event.recordedBefore && !sameBalances(state, event.recordedBefore)) {
      otherActivity = {
        ledgerCents: event.recordedBefore.ledgerCents - state.ledgerCents,
        availableCents: event.recordedBefore.availableCents - state.availableCents,
      };
      state = { ...state, ...balancesOf(event.recordedBefore) };
    }
    const { state: after, explanation } = apply(state, event);
    const balancesMatch = sameBalances(after, event.recorded);
    const entryMatches = event.kind !== "LEDGER_POSTED" || event.ledgerEntryCents === undefined || event.ledgerEntryCents === event.ledgerDeltaCents;
    const matches = balancesMatch && entryMatches;
    if (!matches && !divergence) {
      divergence = {
        stepIndex: steps.length,
        reason: balancesMatch ? "ledger_entry" : "balances",
        eventId: event.id,
        accountSeq: event.accountSeq,
        replayed: balancesOf(after),
        recorded: event.recorded,
      };
    }
    steps.push({ event, before: state, after, explanation, otherActivity, matches });
    state = after;
  }
  return { initial, steps, final: state, consistent: divergence === null, divergence };
}

/**
 * One transaction's trace, rows in account_seq order, each with `recordedBefore`. It starts from
 * the account state just before its first row — the balances the account's previous row
 * recorded — and explains only this transaction's deltas; anything other transactions did in
 * between shows as a step's `otherActivity`. So each step is checked as "recorded after ==
 * recorded before + this row's own effect", which holds however many other rows interleave.
 */
export function replayTransaction(events: ReadonlyArray<ReplayEvent>): ReplayResult {
  const start = events[0]?.recordedBefore ?? { ledgerCents: 0, availableCents: 0 };
  return replay({ ...EMPTY_STATE, ...start }, events);
}

/** Every row on the account in account_seq order, from an empty account. */
export function replayAccount(events: ReadonlyArray<ReplayEvent>): ReplayResult {
  return replay(EMPTY_STATE, events.map((event) => ({ ...event, recordedBefore: undefined })));
}

export interface StoredAccount {
  /** `accounts.ledger_balance_cents`. */
  cachedLedgerCents: number;
  /** SUM(ledger_entries.amount_cents). */
  ledgerSumCents: number;
  /** Ids of the account's ACTIVE holds. */
  activeHoldIds: ReadonlyArray<string>;
  /** Ledger − SUM(active holds), from the holds table. */
  availableCents: number;
}

/**
 * An account replay's final state against what is stored now. Empty when they agree: replayed
 * ledger == cached balance == SUM(ledger), replayed available == available, same active holds.
 */
export function accountMismatches(result: ReplayResult, stored: StoredAccount): string[] {
  const problems: string[] = [];
  const { final } = result;
  if (final.ledgerCents !== stored.cachedLedgerCents) problems.push(`replayed ledger ${final.ledgerCents} ≠ cached balance ${stored.cachedLedgerCents}`);
  if (final.ledgerCents !== stored.ledgerSumCents) problems.push(`replayed ledger ${final.ledgerCents} ≠ sum of ledger entries ${stored.ledgerSumCents}`);
  if (final.availableCents !== stored.availableCents) problems.push(`replayed available ${final.availableCents} ≠ available ${stored.availableCents}`);
  const replayedActive = Object.values(final.holds)
    .filter((hold) => hold.status === "ACTIVE")
    .map((hold) => hold.id)
    .sort();
  const active = [...stored.activeHoldIds].sort();
  if (replayedActive.join() !== active.join()) problems.push(`replayed active holds [${replayedActive.join(", ")}] ≠ active holds [${active.join(", ")}]`);
  return problems;
}
