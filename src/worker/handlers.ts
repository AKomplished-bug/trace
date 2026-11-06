import type { Tx } from "../db/client";
import type { externalEvents } from "../db/schema";
import type { Logger } from "../lib/logger";

export type ExternalEvent = typeof externalEvents.$inferSelect;

/**
 * Two phases, so no network call ever runs inside a database transaction:
 * - `fetch` (optional): provider reads, e.g. re-fetching the object a thin webhook points at.
 *   Runs after the claim has committed and before the processing transaction opens, with a
 *   timeout; pass `signal` to the HTTP client.
 * - `apply`: the event's effects, inside the processing transaction. The event row is locked
 *   and is marked PROCESSED in the same transaction, so a throw rolls everything back.
 *   `apply` must treat `fetched` as possibly stale: lock the account, re-read the entity, and
 *   transition only from the expected status.
 */
export interface EventHandler<T = unknown> {
  fetch?(event: ExternalEvent, log: Logger, signal: AbortSignal): Promise<T>;
  apply(tx: Tx, event: ExternalEvent, fetched: T, log: Logger): Promise<void>;
}

export interface EventRouting {
  /** Handlers keyed by `${provider}:${event_type}`. Provider integrations register here. */
  handlers: Readonly<Record<string, EventHandler>>;
  /** Event types we deliberately don't act on, per provider; these are marked IGNORED. Anything
   * else without a handler is retried and ends FAILED, so it surfaces to Ops. */
  ignored: Readonly<Record<string, readonly string[]>>;
}

export function handlerKey(provider: string, eventType: string): string {
  return `${provider}:${eventType}`;
}

export const routing: EventRouting = { handlers: {}, ignored: {} };
