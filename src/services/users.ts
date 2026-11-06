import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, businesses, users } from "../db/schema";

export type Role = (typeof users.$inferSelect)["role"];

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  businessId: string | null;
  businessName: string | null;
  /** The business's USD account; null for OPS users. */
  accountId: string | null;
}

const sessionUserColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  businessId: users.businessId,
  businessName: businesses.name,
  accountId: accounts.id,
};

/** The user behind a session, with the business and account it is scoped to. */
export async function findSessionUser(db: Db, userId: string): Promise<SessionUser | undefined> {
  const [user] = await db
    .select(sessionUserColumns)
    .from(users)
    .leftJoin(businesses, eq(businesses.id, users.businessId))
    .leftJoin(accounts, and(eq(accounts.businessId, users.businessId), eq(accounts.currency, "USD")))
    .where(eq(users.id, userId));
  return user;
}

/** Demo login: everyone who can sign in to the sandbox. */
export async function listUsers(db: Db): Promise<SessionUser[]> {
  return db
    .select(sessionUserColumns)
    .from(users)
    .leftJoin(businesses, eq(businesses.id, users.businessId))
    .leftJoin(accounts, and(eq(accounts.businessId, users.businessId), eq(accounts.currency, "USD")))
    .orderBy(asc(users.role), asc(users.name));
}
