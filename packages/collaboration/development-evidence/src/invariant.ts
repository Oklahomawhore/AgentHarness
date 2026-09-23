/** Package-owned evidence registry invariants. @module @deepseek-ai/dsh-development-evidence/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-evidence'
/** Cordis companion plugin name. */
export const name = 'development-evidence-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/** Verify provider lifecycle notifications reflect current registry state. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('development-evidence/provider-changed', (provider, state) => {
    const registered = ctx.developmentEvidence.listProviders().some(item => item.id === provider.id)
    if (registered !== (state === 'registered')) {
      fail(`provider event reports "${provider.id}" as ${state} but registry membership disagrees`)
    }
  })
}, { inject: ['developmentEvidence'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
