// Client-safe: the Idempotency-Key the owner money forms send, and what to tell the owner when a request fails.

/** A key and the exact body (as sent) it was used for. */
export interface KeyedBody {
  key: string;
  body: string;
}

/**
 * The key to send `body` with. The same body as last time reuses its key, so a retry after a
 * timeout or an unclear failure replays the first request instead of creating a second one; a
 * changed body gets a new key (reusing the old one would be a 409 conflict). Forget the previous
 * one (pass null) once a request has succeeded.
 */
export function keyFor(previous: KeyedBody | null, body: unknown, newKey: () => string): KeyedBody {
  const serialized = JSON.stringify(body);
  return previous && previous.body === serialized ? previous : { key: newKey(), body: serialized };
}

export const UNCONFIRMED_MESSAGE = "We couldn't confirm this went through. Check Activity before trying again.";
export const UNREACHABLE_MESSAGE = "We couldn't reach Trace. Trying again is safe: the same request can't go through twice.";

/**
 * Plain words for a failed money request. When the outcome is unknown (no answer, a server or
 * provider error, a key conflict) the owner is pointed at Activity; validation and balance
 * messages are already written for owners and pass through.
 */
export function ownerErrorMessage(failure: { status: number | null; code: string | null; message: string }): string {
  if (failure.status === null) return UNREACHABLE_MESSAGE;
  if (failure.status >= 500 || failure.code === "idempotency_conflict") return UNCONFIRMED_MESSAGE;
  if (failure.code === "account_not_linked") return "This account can't send payments yet. Nothing was sent.";
  return failure.message;
}
