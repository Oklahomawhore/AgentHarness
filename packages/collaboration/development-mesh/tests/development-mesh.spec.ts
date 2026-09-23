import { Context } from '@deepseek-ai/cordis'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import { describe, expect, it, vi } from 'vitest'
import DevelopmentMeshService from '../src/index.ts'
import type { DevelopmentMeshSnapshot } from '../src/types.ts'

class MemoryMesh extends DevelopmentMeshService {
  list(): DevelopmentMeshSnapshot {
    return {
      nodeId: 'node-local' as DevelopmentNodeId,
      clusterId: 'cluster',
      secretFingerprint: 'fingerprint',
      peers: [],
    }
  }

  publish(): void {}

  async command(ownerNodeId: DevelopmentNodeId, channel: string, payload: unknown): Promise<unknown> {
    return await this.channel(channel)?.command?.(payload, ownerNodeId)
  }
}

describe('development Mesh channel registry', () => {
  it('publishes registration, rejects duplicate names, and disposes by identity', () => {
    const ctx = new Context()
    const registered = vi.fn()
    ctx.on('development-mesh/channel-registered', registered)
    const mesh = new MemoryMesh(ctx)
    const channel = {
      heads: () => ({}),
      read: () => [],
      receive: () => {},
    }

    const dispose = mesh.register('development-task/v1', channel)
    expect(mesh.channelNames()).toEqual(['development-task/v1'])
    expect(registered).toHaveBeenCalledWith('development-task/v1')
    expect(() => mesh.register('development-task/v1', channel)).toThrow('already registered')
    expect(() => mesh.register('INVALID', channel)).toThrow('channel name is invalid')

    dispose()
    expect(mesh.channel('development-task/v1')).toBeUndefined()
  })
})
