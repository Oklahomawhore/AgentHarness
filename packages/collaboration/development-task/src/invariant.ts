/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-task/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-development-room'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-task'
export const name = 'development-task-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('development-task/persist', (entry) => {
    const previous = ctx.developmentTasks.log().filter(item => item.nodeId === entry.nodeId).at(-1)?.seq ?? 0
    if (entry.seq !== previous + 1) fail(`persist candidate sequence ${String(entry.seq)} does not follow ${String(previous)}`)
  })
  ctx.on('development-task/changed', (snapshot, entry) => {
    const retained = ctx.developmentTasks.log().find(item => item.nodeId === entry.nodeId && item.seq === entry.seq)
    if (retained !== entry) fail(`change event entry ${String(entry.seq)} is not retained`)
    const current = ctx.developmentTasks.get({ taskId: snapshot.id })
    if (current.updatedAt !== entry.at) fail(`change event does not match Task "${snapshot.id}"`)
  })
}, { inject: ['developmentTasks', 'developmentRooms'] })
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
