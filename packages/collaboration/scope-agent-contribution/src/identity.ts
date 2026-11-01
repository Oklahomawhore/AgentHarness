/** Stable source-local identities; hashes do not grant execution or disclosure permission. */
import { createHash } from 'node:crypto'

/**
 * Identify complete retained execution coordinates or logged data.
 * @param value - JSON-serializable source evidence.
 * @returns Lowercase SHA-256, never an authorization token.
 */
export function nativeDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
