/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-task-context/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-task-context'
export const name = 'development-task-context-invariant'
export const inject = ['invariants']
/** No runtime invariant: the Agent loop owns Session admission and its reconstructable event stream. */
const install: InvariantInstaller = Object.assign((_ctx: Context, _fail: InvariantFailure) => {}, {
  inject: ['developmentTasks'],
})
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
