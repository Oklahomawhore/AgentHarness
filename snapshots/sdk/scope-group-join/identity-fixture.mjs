/** This owned keyless process controls clocks and UUID entropy; product authorization still runs normally. */
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

/** Loader fixture identity. */
export const name = 'native-contribution-snapshot-identities'
/** Freeze nondeterministic inputs, with independent UUID counters per production call site. */
export function apply(ctx) {
  const originalNow = Date.now
  const originalUuid = crypto.randomUUID
  const counters = new Map()
  Date.now = () => 1790985600000
  crypto.randomUUID = () => {
    const caller = new Error().stack.split('\n').slice(2)[0].replaceAll('\\', '/').replace(/:\d+:\d+\)?$/, ')')
    const module = caller.includes('/packages/') ? caller.slice(caller.indexOf('/packages/')) : caller.replace(/file:\/\/[^ ]+\//, '')
    const operation = caller.match(/^\s*at (.*?) \(/)?.[1] ?? 'module'
    const location = `${operation}:${module}`
    const ordinal = (counters.get(location) ?? 0) + 1
    counters.set(location, ordinal)
    const hex = crypto.createHash('sha256').update(`scope-group-join/${location}/${ordinal}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  syncBuiltinESMExports()
  ctx.effect(() => () => { Date.now = originalNow; crypto.randomUUID = originalUuid; syncBuiltinESMExports() })
}
