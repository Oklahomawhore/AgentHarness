/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-room-mesh/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-development-room-mesh'
/** Stable invariant companion identity. */
export const name = 'development-room-mesh-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
/** No runtime invariant: authoritative Room service mutations validate owner-node relationships. */
const install: InvariantInstaller = () => {}
/** Register package ownership. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
