/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-room/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-room'
/** Cordis companion plugin name. */
export const name = 'development-room-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']
/** Verify that persistence and room-change events follow the retained append-only log. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('development-room/persist', (entry) => {
    const directory = ctx.developmentRooms.list()
    if (entry.nodeId !== directory.nodeId) {
      fail(`persist candidate for room "${entry.roomId}" is not locally authored`)
      return
    }
    const previous = ctx.developmentRooms.log().filter(item => item.nodeId === directory.nodeId).at(-1)?.seq ?? 0
    if (entry.seq !== previous + 1) {
      fail(`persist candidate sequence ${String(entry.seq)} does not follow ${String(previous)}`)
    }
  })
  ctx.on('development-room/changed', (snapshot, entry) => {
    const current = ctx.developmentRooms.list().rooms.find(room => room.id === snapshot.id)
    if (current === undefined) {
      fail(`change event names unknown room "${snapshot.id}"`)
      return
    }
    const retained = ctx.developmentRooms.log().find(item => item.nodeId === entry.nodeId && item.seq === entry.seq)
    if (retained !== entry) {
      fail(`change event entry ${entry.nodeId}:${String(entry.seq)} is not the retained log entry`)
    }
    if (current.updatedAt !== entry.at || current.objective !== snapshot.objective
      || JSON.stringify(current.participantIds) !== JSON.stringify(snapshot.participantIds)) {
      fail(`change event does not match the current projection for room "${snapshot.id}"`)
    }
  })
}, { inject: ['developmentRooms'] })
/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
