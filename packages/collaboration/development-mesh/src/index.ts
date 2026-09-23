/** Generic authenticated development Mesh Service Definition and channel registry. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import type {
  DevelopmentMeshChannel,
  DevelopmentMeshSnapshot,
} from './types.ts'

export type * from './types.ts'

const CHANNEL_NAME = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*$/u

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated development Mesh and its replication-channel registry. */
    developmentMesh: DevelopmentMeshService
  }
}

/** Provider-neutral registry and transport operations for development channels. */
export abstract class DevelopmentMeshService extends Service {
  private readonly channels = new Map<string, DevelopmentMeshChannel>()

  /** Register this implementation as the one development Mesh provider. */
  constructor(ctx: Context) { super(ctx, 'developmentMesh') }

  /**
   * Register one versioned replication channel.
   * @param name - stable protocol name such as `development-task/v1`.
   * @param channel - heads, delta, receive, and optional command handlers.
   * @returns disposer that removes exactly this registration.
   */
  register(name: string, channel: DevelopmentMeshChannel): () => void {
    if (!CHANNEL_NAME.test(name)) throw new TypeError('development-mesh: channel name is invalid')
    if (this.channels.has(name)) throw new Error(`development-mesh: channel "${name}" is already registered`)
    this.channels.set(name, channel)
    this.ctx.emit('development-mesh/channel-registered', name)
    return () => { if (this.channels.get(name) === channel) this.channels.delete(name) }
  }

  /**
   * Read one registered channel for a transport provider.
   * @param name - exact protocol name.
   * @returns registered handler or undefined.
   */
  channel(name: string): DevelopmentMeshChannel | undefined { return this.channels.get(name) }

  /**
   * Return the current registered protocol names.
   * @returns sorted immutable channel names.
   */
  channelNames(): readonly string[] { return Object.freeze([...this.channels.keys()].sort()) }

  /**
   * Read safe connection, cluster, and conflict status.
   * @returns current provider and peer status without credential material.
   */
  abstract list(): DevelopmentMeshSnapshot

  /**
   * Notify peers that one channel has newly committed local state.
   * @param channel - exact registered channel name.
   */
  abstract publish(channel: string): void

  /**
   * Route one command to its authoritative node.
   * @param ownerNodeId - authenticated destination node.
   * @param channel - exact registered channel name.
   * @param payload - channel-owned wire value.
   * @returns channel-owned response after local or remote execution.
   */
  abstract command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown>
}

export default DevelopmentMeshService
