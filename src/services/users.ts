import { and, eq } from "drizzle-orm";
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

/** Sign-in: the user with this (lower-case) email and their password hash, if there is one. */
export async function findLoginUser(db: Db, email: string): Promise<(SessionUser & { passwordHash: string | null }) | undefined> {
  const [user] = await db
    .select({ ...sessionUserColumns, passwordHash: users.passwordHash })
    .from(users)
    .leftJoin(businesses, eq(businesses.id, users.businessId))
    .leftJoin(accounts, and(eq(accounts.businessId, users.businessId), eq(accounts.currency, "USD")))
    .where(eq(users.email, email));
  return user;
}
