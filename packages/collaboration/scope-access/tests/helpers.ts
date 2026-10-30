/** Controlled authenticated transport with real Task, backend, and scope-access services. */
import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentParticipantId, DevelopmentTaskLogEntry } from '@deepseek-ai/dsh-development-task/types'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import ScopeTransport, { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId, ScopeTransportHandler, ScopeTransportTarget } from '@deepseek-ai/dsh-scope-transport/types'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScopeAccess, { type Config } from '../src/index.ts'

export const peer = (value: string): ScopePeerId => value as ScopePeerId
const contexts: Context[] = []
const network = new Map<ScopePeerId, ControlledTransport>()
export const config: Config = {
  maxGrants: 16, maxSubscriptions: 16, maxProjections: 64, maxContextBytes: 6000, maxResponseBytes: 16384, maxDecodedResponseBytes: 2097152,
  maxConcurrentContributions: 4, maxContributionRequestBytes: 16384,
  maxContributionApplications: 16, maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 60_000,
  requestTimeoutMs: 5000, maxInvitationLifetimeMs: 60_000, maxConcurrentReads: 8, waitTimeoutMs: 3000, maxConcurrentWaits: 3,
}

class ControlledTransport extends ScopeTransport {
  readonly handlers = new Map<string, ScopeTransportHandler>()
  inbound = 0
  outbound = 0
  transform: ((response: unknown) => unknown) | undefined
  constructor(ctx: Context, readonly peerId: ScopePeerId) {
    super(ctx)
    network.set(peerId, this)
    ctx.effect(() => () => { if (network.get(peerId) === this) network.delete(peerId) })
  }

  async identity() { return { peerId: this.peerId, addresses: [`/ip4/127.0.0.1/tcp/1/p2p/${this.peerId}`] } }
  limits() { return { maxInboundRequests: 8, maxOutboundRequests: 8, requestTimeoutMs: 5000 } }
  register(protocol: string, handler: ScopeTransportHandler) {
    this.handlers.set(protocol, handler)
    return () => { this.handlers.delete(protocol) }
  }

  async request(target: ScopeTransportTarget, protocol: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const remote = network.get(target.peerId)
    const handler = remote?.handlers.get(protocol)
    if (remote === undefined || handler === undefined) throw new ScopeTransportError('scope-transport/unavailable')
    if (this.outbound >= this.limits().maxOutboundRequests || remote.inbound >= remote.limits().maxInboundRequests) {
      throw new ScopeTransportError('scope-transport/capacity')
    }
    this.outbound++; remote.inbound++
    try {
      const reply = await handler({ peerId: this.peerId, payload: JSON.parse(JSON.stringify(payload)), signal })
      const response = JSON.parse(JSON.stringify(reply)) as unknown
      return this.transform === undefined ? response : await this.transform(response)
    } finally { this.outbound--; remote.inbound-- }
  }
}

export async function cleanup(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  network.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
}

export async function host(id: string, pool = new MemoryMediaPool(), overrides: Partial<Config> = {},
  taskEvents: readonly DevelopmentTaskLogEntry[] = [], transportPeerId: ScopePeerId = peer(id), maxEventsPerTask = 32) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
  const exit = vi.fn<(code: number) => void>()
  ctx.provide('appExit', exit)
  await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('memory', new MemoryStorageBackend(pool)))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.provide('storageDomain', facility)
  ctx.effect(() => () => facility.closeAll())
  new DevelopmentRoomService(ctx, { nodeId: id, presenceTtlMs: 10_000, maxParticipants: 16, maxRooms: 32, maxTextBytes: 4096 })
  const tasks = new DevelopmentTaskService(ctx, {
    maxTasks: 16, maxEventsPerTask, maxMergeParents: 4, maxContextBlockBytes: 65536,
    maxLineageTasks: 16, maxTextBytes: 4096, roomRetryIntervalMs: 10_000,
  })
  const participantId = 'owner' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: participantId, kind: 'human', displayName: 'Owner' })
  tasks.restoreLog(taskEvents)
  const backendFork = ctx.plugin(TextBackend)
  await backendFork
  const backend = ctx.developmentTaskContextBackend
  const transport = new ControlledTransport(ctx, transportPeerId)
  const access = new ScopeAccess(ctx, Object.assign({}, config, overrides))
  const createTask = async (objective = 'Shared canary') => await tasks.create({
    origin: { kind: 'root' }, objective, scope: 'One explicit project', createdBy: participantId,
  })
  return { ctx, pool, tasks, participantId, backend, backendFork, transport, access, createTask, exit }
}
