import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// OWASP's scrypt option N=2^15, r=8, p=3: 32 MiB per hash, sized for a 0.25 vCPU web task.
const PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Node refuses scrypt above 32 MiB by default; 128 * N * r is exactly that, so allow headroom.
const MAX_MEM = 64 * 1024 * 1024;
// Bounds for parameters read back from a stored hash.
const MAX_N = 2 ** 20;

function derive(password: string, salt: Buffer, keyBytes: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, { ...options, maxmem: MAX_MEM }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url: everything verify needs, in one string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function parse(stored: string) {
  const [scheme, n, r, p, salt, hash, extra] = stored.split("$");
  const N = Number(n);
  const params = { N, r: Number(r), p: Number(p) };
  const valid =
    scheme === "scrypt" &&
    extra === undefined &&
    Number.isInteger(N) &&
    N > 1 &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= 32 &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= 16 &&
    !!salt &&
    !!hash;
  if (!valid) throw new Error("Stored password hash is malformed");
  return { params, salt: Buffer.from(salt, "base64url"), hash: Buffer.from(hash, "base64url") };
}

// Salt for the dummy derivation when there is no stored hash; its output is never compared.
const DUMMY_SALT = randomBytes(SALT_BYTES);

/**
 * Whether `password` matches `stored`. With no stored hash (unknown user, or no password set) it
 * still runs scrypt against a dummy hash and answers false, so timing doesn't tell them apart.
 * A malformed stored hash throws: it is our bug, never a match.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    await derive(password, DUMMY_SALT, KEY_BYTES, PARAMS);
    return false;
  }
  const { params, salt, hash } = parse(stored);
  const key = await derive(password, salt, hash.length, params);
  return timingSafeEqual(key, hash);
}
