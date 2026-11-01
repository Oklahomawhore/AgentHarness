/** Pin message UUID entropy in this owned keyless process before completed-turn identities are derived. */
import { createHash } from 'node:crypto'
import { apply as applyNativeIdentities } from '../scope-native-contribution/identity-fixture.mjs'

/** Loader fixture identity. */
export const name = 'turn-outcome-snapshot-identities'
/** Keep native authorization entropy and message UUID bytes deterministic without changing production IDs. */
export function apply(ctx) {
  applyNativeIdentities(ctx)
  const original = globalThis.crypto.getRandomValues
  let messageOrdinal = 0
  globalThis.crypto.getRandomValues = function (bytes) {
    const caller = new Error().stack.split('\n')[2].replaceAll('\\', '/')
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16 || !caller.includes('/packages/util/crypto/lib/index.js:')) {
      return original.call(this, bytes)
    }
    const digest = createHash('sha256').update(`scope-turn-outcomes/message/${++messageOrdinal}`).digest()
    bytes.set(digest.subarray(0, 16))
    return bytes
  }
  ctx.effect(() => () => { globalThis.crypto.getRandomValues = original })
}
