import { randomBytes } from "crypto";
import bigInt from "big-integer";
import { readBigIntFromBuffer } from "telegram/Helpers.js";

/** Convert native bigint or number to BigInteger for GramJS TL long fields */
export function toLong(value: bigint | number) {
  return bigInt(String(value));
}

/** Generate cryptographically random BigInteger for randomId / poll ID fields */
export function randomLong() {
  return readBigIntFromBuffer(randomBytes(8), false, true);
}
