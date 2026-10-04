// Counters that wrap at 16 bits, as the wire carries them: an input's `seq`, a
// snapshot's `ack`, an event's id. One definition, because the client deciding
// what is still unacknowledged and the server deciding what is new must agree.

/**
 * Whether `seq` is newer than `ack`, over a counter that wraps at 16 bits.
 *
 * A plain `>` is wrong twice a wrap: a client 18 minutes into a match sends seq 3
 * and is acked at 65534, and every input it has ever sent looks unacknowledged.
 * The usual trick — the difference, read as signed — is right as long as the two
 * are within half a period of each other, which two seconds of inputs comfortably
 * are.
 */
export function after(seq: number, ack: number): boolean {
  return ((seq - ack) & 0xffff) !== 0 && ((seq - ack) & 0xffff) < 0x8000;
}
