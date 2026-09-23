/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-mesh/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-mesh'
/** Stable invariant companion identity. */
export const name = 'development-mesh-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']
/** No runtime invariant: the registry rejects duplicate channel ownership synchronously. */
const install: InvariantInstaller = () => {}
/** Register the Mesh registry's runtime invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
