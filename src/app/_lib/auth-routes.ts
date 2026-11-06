import type { Role } from "../../services/users";

/** Home page for each role. */
export const HOME_FOR_ROLE: Record<Role, string> = { OWNER: "/", OPS: "/ops" };
