/**
 * Error text that is safe to store (e.g. `external_events.last_error`) and log: the error class
 * and our own message. Database errors keep only their SQLSTATE and the constraint/table/column
 * names — never the server message, `detail` or query params, which can contain row values.
 */

/**
 * Retrying can't change the outcome (the event contradicts our records), so the worker marks the
 * event FAILED for Ops at once instead of spending its retry budget. Subclass it with a specific
 * name. Lives here, not in the worker, because services throw it.
 */
export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEventError";
  }
}

interface DatabaseErrorLike extends Error {
  code: string;
  severity: string;
  constraint?: string;
  table?: string;
  column?: string;
}

const SQLSTATE_NAMES: Record<string, string> = {
  "23503": "foreign key violation",
  "23505": "unique violation",
  "23514": "check violation",
  "25P03": "idle in transaction timeout",
  "40001": "serialization failure",
  "40P01": "deadlock detected",
  "55P03": "lock not available",
  "57014": "statement timeout",
};

function isDatabaseError(error: unknown): error is DatabaseErrorLike {
  return (
    error instanceof Error &&
    typeof (error as Partial<DatabaseErrorLike>).code === "string" &&
    typeof (error as Partial<DatabaseErrorLike>).severity === "string"
  );
}

// Drizzle wraps driver errors in an error whose message is the SQL plus its params.
function isQueryWrapper(error: Error): boolean {
  return "query" in error && "params" in error;
}

function describeDatabaseError(error: DatabaseErrorLike): string {
  const parts = [`DatabaseError ${error.code}`];
  if (SQLSTATE_NAMES[error.code]) parts.push(`(${SQLSTATE_NAMES[error.code]})`);
  if (error.constraint) parts.push(`constraint=${error.constraint}`);
  if (error.table) parts.push(`table=${error.table}`);
  if (error.column) parts.push(`column=${error.column}`);
  return parts.join(" ");
}

export function safeErrorMessage(error: unknown): string {
  if (isDatabaseError(error)) return describeDatabaseError(error);
  if (!(error instanceof Error)) return "Unknown error";
  if (isQueryWrapper(error)) return error.cause === undefined ? "Database query failed" : safeErrorMessage(error.cause);
  return `${error.name}: ${error.message}`;
}

/** For `log.error({ err: safeErrorForLog(error) }, …)`; keeps the stack only for our own errors. */
export function safeErrorForLog(error: unknown): { message: string; stack?: string } {
  const message = safeErrorMessage(error);
  const ours = error instanceof Error && !isDatabaseError(error) && !isQueryWrapper(error);
  return ours ? { message, stack: error.stack } : { message };
}
