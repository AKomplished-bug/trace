import { randomUUID } from "node:crypto";

/** Primary keys and correlation ids are UUIDv4. */
export function newId(): string {
  return randomUUID();
}
