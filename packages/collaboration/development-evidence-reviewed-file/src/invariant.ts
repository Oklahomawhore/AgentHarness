/** Package-owned reviewed-file provider invariant. @module @deepseek-ai/dsh-development-evidence-reviewed-file/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-evidence-reviewed-file'
/** Cordis companion plugin name. */
export const name = 'development-evidence-reviewed-file-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']
/** No runtime invariant: the evidence registry owns provider lifecycle consistency. */
const install: InvariantInstaller = () => {}

/** Register this provider package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
