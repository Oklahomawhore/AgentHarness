/** Package-owned invariant companion. @module @deepseek-ai/dsh-agentharness-bridge/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agentharness-bridge'
export const name = 'agentharness-bridge-invariant'
export const inject = ['invariants']
/** No runtime invariant: this stateless protocol adapter exposes no independent mutable relation. */
const install: InvariantInstaller = Object.assign((_ctx: Context, _fail: InvariantFailure) => {}, { inject: [] })
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
