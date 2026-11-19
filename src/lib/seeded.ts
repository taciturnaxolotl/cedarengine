import { createHash } from "node:crypto";

/** A small deterministic stream of numbers from any seed string. */
export function stream(seed: string) {
  let state = createHash("sha256").update(seed).digest();
  let at = 0;
  return () => {
    if (at + 4 > state.length) {
      state = createHash("sha256").update(state).digest();
      at = 0;
    }
    const value = state.readUInt32BE(at);
    at += 4;
    return value;
  };
}
