/** This owned keyless process controls clocks and UUID entropy; product authorization still runs normally. */
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

/** Loader fixture identity. */
export const name = 'native-contribution-snapshot-identities'
/** Read-grant generation retained by this scenario's replay input. */
export const readGrantGeneration = '80498660-bd7f-4ce8-a92a-78ff94feea67'
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
    // The owned built Host's first invite allocates grantId then generation; pin only that replay authorization.
    if (location === 'module:/packages/collaboration/scope-access/lib/index.js)' && ordinal === 2) return readGrantGeneration
    const hex = crypto.createHash('sha256').update(`scope-command-outcomes/${location}/${ordinal}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  syncBuiltinESMExports()
  ctx.effect(() => () => { Date.now = originalNow; crypto.randomUUID = originalUuid; syncBuiltinESMExports() })
}
