/** Package-owned MCP registry invariants. @module @deepseek-ai/dsh-mcp/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp'
/** Cordis companion plugin name. */
export const name = 'mcp-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/** Verify lifecycle notifications agree with current server membership. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('mcp/server-changed', (server, state) => {
    const registered = ctx.mcp.listServers().some(item => item.id === server.id)
    if (registered !== (state === 'registered')) {
      fail(`server event reports "${server.id}" as ${state} but registry membership disagrees`)
    }
  })
}, { inject: ['mcp'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
