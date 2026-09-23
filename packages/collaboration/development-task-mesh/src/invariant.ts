/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-task-mesh/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-development-task-mesh'
/** Stable invariant companion identity. */
export const name = 'development-task-mesh-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
/** No runtime invariant: Task and assignment services reject origin and identity conflicts synchronously. */
const install: InvariantInstaller = () => {}
/** Register package ownership. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
