import type { Tx } from "../db/client";
import { auditEvents } from "../db/schema";

/** Flat scalars only (ids, statuses, counts), so a payload or personal data can't be passed in whole. */
export type AuditState = Record<string, string | number | boolean | null>;

export interface AuditInput {
  /** The signed-in user who acted; null for the system. */
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  previousState: AuditState | null;
  newState: AuditState | null;
  correlationId: string;
}

/**
 * The only writer of `audit_events`. Takes the action's own transaction, so the audit row commits
 * if and only if the action does.
 */
export async function recordAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    actorType: input.actorUserId ? "USER" : "SYSTEM",
    actorId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    previousState: input.previousState,
    newState: input.newState,
    correlationId: input.correlationId,
  });
}
