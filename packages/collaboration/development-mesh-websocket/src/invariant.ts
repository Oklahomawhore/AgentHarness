/** Package-owned invariant companion. @module @deepseek-ai/dsh-development-mesh-websocket/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-mesh-websocket'
/** Stable invariant companion identity. */
export const name = 'development-mesh-websocket-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']
/** No runtime invariant: frame authentication, replay, and peer state are checked synchronously. */
const install: InvariantInstaller = () => {}
/** Register the provider's runtime invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
