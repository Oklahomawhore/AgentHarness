/** Package-owned storage invariant companion. @module @deepseek-ai/dsh-development-task-storage-domain/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-task-storage-domain'
export const name = 'development-task-storage-domain-invariant'
export const inject = ['invariants']
/** No runtime invariant: durable replay and append correctness are verified at the storage boundary. */
const install: InvariantInstaller = Object.assign((_ctx: Context, _fail: InvariantFailure) => {}, {
  inject: ['developmentTasks', 'storageDomain'],
})
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
