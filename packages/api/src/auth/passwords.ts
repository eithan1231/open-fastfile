// Turning what a player typed into something safe to store, and back into a
// yes or a no.
//
// argon2id, at the reference implementation's defaults — 19 MiB, two passes —
// which is what OWASP recommends and what the encoded hash carries with it, so a
// row written today still verifies after those parameters are raised. It is
// memory-hard, which is the property scrypt and bcrypt were reached for and
// bcrypt does not really have.
//
// Async, and deliberately: hashing is ~12 ms of deliberate work, and this is the
// single process that also serves every world asset and holds every event
// stream open. @node-rs/argon2 does it on libuv's threadpool, so a sign-in costs
// nobody else their latency.

import { scryptSync, createHash, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { singleton } from "tsyringe";

/** What scrypt rows look like: `salt:hash`, both hex. Nothing writes these any more. */
const LEGACY_SCRYPT = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

@singleton()
export class Passwords {
  /** The library's defaults, which are argon2id at OWASP's parameters — and are recorded in the hash. */
  hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    if (LEGACY_SCRYPT.test(stored)) {
      return this.verifyScrypt(plain, stored);
    }
    // A malformed or truncated hash is a no, not a crash: a row we cannot read
    // is a row nobody can sign in against, and that is the safe reading of it.
    return verify(stored, plain).catch(() => false);
  }

  /**
   * Whether this row should be replaced the next time we hold the plaintext —
   * which is the one moment it can be, at a successful sign-in. Rewriting it
   * then is what retires the scrypt column without a migration that cannot
   * possibly work, since a migration has no passwords to hash.
   */
  outdated(stored: string): boolean {
    return LEGACY_SCRYPT.test(stored);
  }

  /** scrypt with a per-password salt, as `salt:hash`. Verified, never written. */
  private verifyScrypt(plain: string, stored: string): boolean {
    const [salt, expected] = stored.split(":");
    if (salt === undefined || expected === undefined) {
      return false;
    }
    const actual = scryptSync(plain, salt, 64).toString("hex");
    // Same length by construction, but go through a digest anyway: it costs
    // nothing and means nobody has to prove that the next caller's input is.
    const a = createHash("sha256").update(actual).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  }
}
