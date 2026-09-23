/** Package-owned durable development-room invariants. @module @deepseek-ai/dsh-development-room-storage-domain/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-development-room'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { DEVELOPMENT_ROOM_DOMAIN_NAME, type DevelopmentRoomLogRecord } from './schema.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-room-storage-domain'
/** Cordis companion plugin name. */
export const name = 'development-room-storage-domain-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/** Verify each durable log write exactly appends the candidate awaiting publication. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const pending = new Map<string, DevelopmentRoomLogRecord>()
  ctx.on('development-room/persist', (entry) => {
    pending.set(entry.nodeId, {
      entries: [...ctx.developmentRooms.log().filter(item => item.nodeId === entry.nodeId), entry],
    })
  }, { prepend: true })
  ctx.on('domain/changed', (change) => {
    if (change.domain !== DEVELOPMENT_ROOM_DOMAIN_NAME || change.table !== 'logs' || change.operation !== 'put') return
    const durable = change.value as DevelopmentRoomLogRecord
    const candidate = pending.get(change.key)
    if (candidate === undefined) {
      fail(`durable room log has no pending publication for "${change.key}"`)
      return
    }
    if (JSON.stringify(candidate) !== JSON.stringify(durable)) {
      fail(`durable room log "${change.key}" contradicts pending sequence ${String(candidate.entries.at(-1)?.seq)}`)
    }
  })
  ctx.on('development-room/changed', (_snapshot, entry, origin) => {
    if (origin.kind !== 'local') return
    const candidate = pending.get(entry.nodeId)
    if (candidate?.entries.at(-1)?.seq === entry.seq) pending.delete(entry.nodeId)
  })
}, { inject: ['developmentRooms'] })

/** Register the durable development-room invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
