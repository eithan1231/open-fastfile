// The only randomness a script may have, and the hash that stands in for it.
//
// A script hook both ends run has to be a pure function of what it is given, for
// the reason `resolveWeapon` is: a client predicting and a server replaying must
// get identical values out of identical inputs, and a divergence here looks like
// a physics bug rather than a seeding bug. `Math.random()` is in `lib: ["ES2022"]`
// so the tsconfig cannot catch it — eslint.config.js bans it over this subtree
// instead, and this is what it points at.

/**
 * xorshift32, seeded. The same seed draws the same sequence on both ends.
 *
 * Not for anything cryptographic and not for anything that must be fair; it is
 * for a choice two machines have to make the same way.
 */
export function seeded(seed: number): () => number {
  // 0 is a fixed point of xorshift, so it is never a usable state.
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // >>> 0 first: the shifts above leave a signed 32-bit value.
    return (state >>> 0) / 0x100000000;
  };
}

/**
 * FNV-1a over a string, as a non-negative 32-bit number.
 *
 * What picks a peer's body from their player id, which is how every client
 * arrives at the same body for the same player without anybody being told: the id
 * is the same everywhere, so the hash is too. `net/remotePlayers.ts` had its own
 * copy of this; a second one would be a second answer.
 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
