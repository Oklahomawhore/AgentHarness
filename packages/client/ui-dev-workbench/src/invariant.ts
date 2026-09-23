/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-dev-workbench/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-dev-workbench'
/** Stable invariant companion identity. */
export const name = 'client-ui-dev-workbench-invariant'
/** Services required to register this package's invariant companion. */
export const inject = ['invariants']
/** No runtime invariant: this presentation-only package owns no authoritative runtime relationship. */
const install: InvariantInstaller = () => {}
/** Register the empty companion because this presentation-only package owns no runtime relationship. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
