/** Package-owned live-Agent presence invariants. @module @deepseek-ai/dsh-development-room-agent-presence/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { developmentAgentParticipantId } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-room-agent-presence'
/** Cordis companion plugin name. */
export const name = 'development-room-agent-presence-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/** Verify presence events that correspond to a currently live Agent. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('development-room/presence-changed', (participant) => {
    const agent = ctx.get('agents')?.list()
      .find(candidate => developmentAgentParticipantId(candidate.id) === participant.id)
    if (agent === undefined) return
    if (participant.kind !== 'agent') fail(`live Agent participant "${participant.id}" must retain kind agent`)
    if (participant.presence !== 'online') fail(`live Agent participant "${participant.id}" must remain online`)
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns disposer after the relationship audit is installed.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
