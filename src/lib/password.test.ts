import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("stores the scheme, parameters, a random salt and the hash in one string", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
    expect(await hashPassword("correct horse battery")).not.toBe(stored);
  });

  it("verifies the right password and rejects any other", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("verifies with the parameters recorded in the hash", async () => {
    const stored = await hashPassword("correct horse battery");
    const [, , , , salt] = stored.split("$");
    // A hash made with other parameters still verifies, so they can be raised later.
    const older = `scrypt$16384$8$1$${salt}$${scryptSync("correct horse battery", Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 }).toString("base64url")}`;
    expect(await verifyPassword("correct horse battery", older)).toBe(true);
  });

  it("answers false without a stored hash, after doing the same work", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", undefined)).toBe(false);
  });

  it("throws on a malformed stored hash instead of matching", async () => {
    for (const stored of ["plain", "scrypt$1000$8$1$c2FsdA$aGFzaA", "scrypt$32768$8$1$$aGFzaA", "bcrypt$32768$8$1$c2FsdA$aGFzaA", "scrypt$1048576000$8$1$c2FsdA$aGFzaA"]) {
      await expect(verifyPassword("x", stored), stored).rejects.toThrow("malformed");
    }
  });
});
