/** Package-owned durable shared-room context invariants. @module @deepseek-ai/dsh-development-room-context-storage-domain/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-development-room-context'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-storage-domain'
import {
  DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME,
  type DevelopmentRoomContextLogRecord,
} from './schema.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-room-context-storage-domain'
/** Cordis companion plugin name. */
export const name = 'development-room-context-storage-domain-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/** Verify each durable write exactly appends the candidate awaiting publication. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const pending = new Map<string, DevelopmentRoomContextLogRecord>()
  ctx.on('development-room-context/persist', (entry) => {
    pending.set(entry.nodeId, {
      entries: [...ctx.developmentRoomContexts.log(), entry],
    })
  }, { prepend: true })
  ctx.on('domain/changed', (change) => {
    if (change.domain !== DEVELOPMENT_ROOM_CONTEXT_DOMAIN_NAME
      || change.table !== 'logs' || change.operation !== 'put') return
    const durable = change.value as DevelopmentRoomContextLogRecord
    const candidate = pending.get(change.key)
    if (candidate === undefined) {
      fail(`durable shared-context log has no pending publication for "${change.key}"`)
      return
    }
    if (JSON.stringify(candidate) !== JSON.stringify(durable)) {
      fail(`durable shared-context log "${change.key}" contradicts pending sequence ${String(candidate.entries.at(-1)?.seq)}`)
    }
  })
  ctx.on('development-room-context/changed', (entry, origin) => {
    if (origin.kind !== 'local') return
    const candidate = pending.get(entry.nodeId)
    if (candidate?.entries.at(-1)?.seq === entry.seq) pending.delete(entry.nodeId)
  })
}, { inject: ['developmentRoomContexts'] })

/**
 * Register the durable shared-context invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
