/** Persistent listener selection sampled once per transport startup. */
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import Libp2pScopeTransport from '@deepseek-ai/dsh-scope-transport/libp2p'
import type { Config } from './libp2p.ts'
import { validateManagedListeners } from './address.ts'

export type { Config } from './libp2p.ts'

const networkSchema = s.object({ listenAddresses: s.array(s.string()).min(1).required() })

/**
 * Use the durable scope-network listener settings after restart; live requests retain their original listeners and identity.
 * Non-loopback listeners require fixed nonzero ports in both composition values and user settings.
 */
export default class SettingsLibp2pScopeTransport extends Libp2pScopeTransport {
  static override inject = ['credentials', 'settings']
  static override Config: s<Config> = s.intersect([Libp2pScopeTransport.Config])

  constructor(ctx: Context, config: Config) {
    const settings = ctx.settings.register('scope-network', networkSchema, {
      base: { listenAddresses: config.listenAddresses }, applies: 'restart',
      validate: (value) => { validateManagedListeners(value.listenAddresses) },
    })
    super(ctx, { ...config, listenAddresses: settings.get().listenAddresses })
  }
}
