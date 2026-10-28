import { Context } from '@deepseek-ai/cordis'
import { createHmac, randomUUID } from 'node:crypto'
import CredentialProvider, { type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import DevelopmentRoomService, {
  type DevelopmentNodeId,
  type DevelopmentParticipantId,
} from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import DevelopmentMeshWebSocketService, { type Config, type PeerConfig } from '../src/index.ts'
import DevelopmentRoomMeshService from '../../development-room-mesh/src/index.ts'
import DevelopmentTaskMeshService from '../../development-task-mesh/src/index.ts'
import { isMulticastAddress, LanPeerDiscovery, ownsDial } from '../src/discovery.ts'

const SHARED_SECRET = 'one-test-mesh-secret-with-at-least-thirty-two-bytes'
const contexts: Context[] = []
const rawSockets: WebSocket[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId

class StaticCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly config: { secret?: string }) { super(ctx) }
  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.config.secret === undefined ? undefined : { value: this.config.secret, source: 'test' }
  }
  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.config.secret !== undefined, source: 'test', writable: false }
  }
  async set(): Promise<void> { throw new Error('read-only test credentials') }
  async unset(): Promise<void> { throw new Error('read-only test credentials') }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: false } }
  async listRecords() { return [] }
  async modifyRecord() { return undefined }
  async deleteRecord() {}
}

interface TestNode {
  readonly ctx: Context
  readonly nodeId: DevelopmentNodeId
  readonly humanId: DevelopmentParticipantId
  stopMesh?: () => Promise<void>
}

afterEach(async () => {
  for (const socket of rawSockets.splice(0)) socket.terminate()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const discovery: Config['discovery'] = {
  enabled: false,
  cluster: 'agentharness-task-test',
  multicastAddress: '239.255.73.67',
  port: 45_892,
  announceIntervalMs: 50,
  peerTtlMs: 200,
  maxDatagramBytes: 2_048,
}

function config(peers: readonly PeerConfig[]): Config {
  return {
    path: '/internal/development-mesh',
    secretRef: 'AGENTHARNESS_MESH_SECRET',
    peers: [...peers],
    discovery,
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 100,
    commandTimeoutMs: 1_000,
    maxMessageBytes: 256 * 1024,
    maxEventsPerFrame: 4_096,
  }
}

async function baseNode(nodeId: string, secret: string | null = SHARED_SECRET): Promise<TestNode> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DevelopmentRoomService, {
    nodeId,
    presenceTtlMs: 10_000,
    maxParticipants: 32,
    maxRooms: 128,
    maxTextBytes: 2_048,
  })
  await ctx.plugin(DevelopmentTaskService, {
    maxTasks: 128,
    maxEventsPerTask: 128,
    maxMergeParents: 16,
    maxContextBlockBytes: 256 * 1024,
    maxLineageTasks: 500,
    roomRetryIntervalMs: 10_000,
    maxTextBytes: 8_192,
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(StaticCredentials, secret === null ? {} : { secret })
  const humanId = participant(`human-${nodeId}`)
  await ctx.developmentRooms.announce({ id: humanId, kind: 'human', displayName: `Human ${nodeId}` })
  return { ctx, nodeId: nodeId as DevelopmentNodeId, humanId }
}

async function startMesh(node: TestNode, peers: readonly PeerConfig[], overlay: Partial<Config> = {}): Promise<void> {
  const provider = await node.ctx.plugin(DevelopmentMeshWebSocketService, { ...config(peers), ...overlay })
  const room = await node.ctx.plugin(DevelopmentRoomMeshService)
  const task = await node.ctx.plugin(DevelopmentTaskMeshService)
  node.stopMesh = async () => {
    await task.dispose()
    await room.dispose()
    await provider.dispose()
    delete node.stopMesh
  }
}

async function waitFor(check: () => boolean, details: () => unknown = () => undefined): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error(`Mesh state did not converge: ${JSON.stringify(details())}`)
}

function peer(node: TestNode, connect: boolean): PeerConfig {
  return { nodeId: node.nodeId, url: `ws://127.0.0.1:${String(node.ctx.webServer.port)}`, connect }
}

async function startThree(first: TestNode, second: TestNode, third: TestNode): Promise<void> {
  await startMesh(third, [peer(first, false), peer(second, false)])
  await startMesh(second, [peer(first, false), peer(third, true)])
  await startMesh(first, [peer(second, true), peer(third, true)])
  await waitFor(
    () => [first, second, third].every(node => node.ctx.developmentMesh.list().peers.length === 2
      && node.ctx.developmentMesh.list().peers.every(item => item.state === 'online')),
    () => [first, second, third].map(node => node.ctx.developmentMesh.list()),
  )
}

async function waitForTask(node: TestNode, taskId: DevelopmentTaskId, revision?: number): Promise<void> {
  await waitFor(() => {
    try {
      const task = node.ctx.developmentTasks.get({ taskId })
      return revision === undefined || task.revision >= revision
    } catch { return false }
  }, () => node.ctx.developmentTasks.list({ limit: 128 }))
}

function signature(value: string): string {
  return createHmac('sha256', SHARED_SECRET).update(value).digest('hex')
}

async function rawConnect(target: TestNode, attacker = 'attacker-node'): Promise<WebSocket> {
  const at = Date.now()
  const nonce = randomUUID()
  const path = '/internal/development-mesh'
  const socket = new WebSocket(`ws://127.0.0.1:${String(target.ctx.webServer.port)}${path}`, { headers: {
    'x-dsh-mesh-node': attacker,
    'x-dsh-mesh-target': target.nodeId,
    'x-dsh-mesh-nonce': nonce,
    'x-dsh-mesh-at': String(at),
    'x-dsh-mesh-mac': signature(`${attacker}\n${target.nodeId}\n${nonce}\n${String(at)}\n${path}`),
  } })
  rawSockets.push(socket)
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.once('error', reject)
  })
  return socket
}

function envelope(target: TestNode, seq: number, body: unknown, attacker = 'attacker-node'): string {
  const frame = {
    version: 1,
    nodeId: attacker,
    targetNodeId: target.nodeId,
    nonce: randomUUID(),
    seq,
    at: Date.now(),
    body,
  }
  const payload = Buffer.from(JSON.stringify(frame)).toString('base64url')
  return JSON.stringify({ payload, mac: signature(payload) })
}

async function introduce(target: TestNode, socket: WebSocket): Promise<void> {
  socket.send(envelope(target, 1, { type: 'hello' }))
  await waitFor(() => target.ctx.developmentMesh.list().peers[0]?.state === 'online')
}

describe('authenticated generic development Mesh', () => {
  it('catches up a real Room and Task backlog through bounded frames before routing a later owner command', async () => {
    const source = await baseNode('node-backlog-source')
    const receiver = await baseNode('node-backlog-receiver')
    const first = await source.ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'First offline Task', scope: 'source role', createdBy: source.humanId,
    })
    const second = await source.ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Second offline Task', scope: 'source role', createdBy: source.humanId,
    })
    const published = await source.ctx.developmentTasks.publishContext({
      taskId: first.id, participantId: source.humanId, text: 'Published before the receiver joined',
    })
    expect(source.ctx.developmentTasks.log().length).toBeGreaterThan(2)
    await startMesh(source, [peer(receiver, true)], {
      maxEventsPerFrame: 2, reconnectInitialDelayMs: 1_000, reconnectMaxDelayMs: 1_000,
    })
    await startMesh(receiver, [peer(source, false)])
    await Promise.all([waitForTask(receiver, first.id, published.revision), waitForTask(receiver, second.id)])
    expect(receiver.ctx.developmentTasks.contextView(first.id).task.context)
      .toContainEqual(expect.objectContaining({ text: 'Published before the receiver joined' }))
    const routed = await receiver.ctx.developmentTasks.publishContext({
      taskId: first.id, participantId: source.humanId, text: 'Owner command after catch-up',
    })
    expect(routed.ownerNodeId).toBe(source.nodeId)
    expect(routed.revision).toBe(published.revision + 1)
    await waitForTask(source, first.id, routed.revision)
  })

  it('preserves multibyte Task context across byte-bounded signed frames and keeps small owner commands usable', async () => {
    const source = await baseNode('node-byte-source')
    const receiver = await baseNode('node-byte-receiver')
    const task = await source.ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Multibyte offline context', scope: 'source role', createdBy: source.humanId,
    })
    const commandTarget = await source.ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Small owner command', scope: 'source role', createdBy: source.humanId,
    })
    const texts = Array.from({ length: 3 }, (_, index) => `第${String(index + 1)}轮事实同步🙂`.repeat(100))
    for (const text of texts) await source.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: source.humanId, text })
    const limit = 5_000
    const sending = vi.spyOn(WebSocket.prototype, 'send')
    try {
      await startMesh(source, [peer(receiver, true)], {
        maxMessageBytes: limit, reconnectInitialDelayMs: 1_000, reconnectMaxDelayMs: 1_000,
      })
      await startMesh(receiver, [peer(source, false)])
      await Promise.all([waitForTask(receiver, task.id, 4), waitForTask(receiver, commandTarget.id)])
      expect(receiver.ctx.developmentTasks.contextView(task.id).task.context.map(item => item.text)).toEqual(texts)
      const routed = await receiver.ctx.developmentTasks.publishContext({
        taskId: commandTarget.id, participantId: source.humanId, text: 'Bounded command after multibyte catch-up',
      })
      expect(routed.ownerNodeId).toBe(source.nodeId)
      expect(routed.revision).toBe(2)
      const frames = sending.mock.calls.map(([bytes]) => {
        if (typeof bytes !== 'string') throw new Error('Mesh sent a non-text frame')
        const outer = JSON.parse(bytes) as { payload: string; mac: string }
        expect(outer.mac).toBe(signature(outer.payload))
        const frame = JSON.parse(Buffer.from(outer.payload, 'base64url').toString('utf8')) as {
          nodeId: string
          body: { type: string; channel?: string }
        }
        return { bytes, frame }
      }).filter(item => item.frame.nodeId === source.nodeId)
      expect(frames.filter(item => item.frame.body.type === 'events' && item.frame.body.channel === 'development-task/v1').length)
        .toBeGreaterThan(1)
      for (const { bytes } of frames) expect(Buffer.byteLength(bytes, 'utf8')).toBeLessThanOrEqual(limit)
    } finally { sending.mockRestore() }
  })

  it('reports an indivisible oversized Task event and permits bounded Room commands after the faulty channel is unloaded', async () => {
    const source = await baseNode('node-single-source')
    const receiver = await baseNode('node-single-receiver')
    const task = await source.ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'One oversized publication', scope: 'source role', createdBy: source.humanId,
    })
    await startMesh(receiver, [peer(source, false)])
    await source.ctx.plugin(DevelopmentMeshWebSocketService, {
      ...config([peer(receiver, true)]), maxMessageBytes: 2_048, reconnectInitialDelayMs: 1_000, reconnectMaxDelayMs: 1_000,
    })
    await source.ctx.plugin(DevelopmentRoomMeshService)
    const taskChannel = await source.ctx.plugin(DevelopmentTaskMeshService)
    await waitForTask(receiver, task.id)
    const failures: string[] = []
    source.ctx.on('development-mesh/peer-changed', (snapshot) => {
      if (snapshot.state === 'offline' && snapshot.lastError?.includes('maxMessageBytes')) failures.push(snapshot.lastError)
    })
    const text = '不可分割的事实🙂'.repeat(200)
    await source.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: source.humanId, text })
    await waitFor(() => failures.length > 0, () => source.ctx.developmentMesh.list())
    expect(source.ctx.developmentTasks.contextView(task.id).task.context.map(item => item.text)).toEqual([text])
    expect(receiver.ctx.developmentTasks.contextView(task.id).task.context).toEqual([])
    await taskChannel.dispose()
    await waitFor(() => [source, receiver].every(node => node.ctx.developmentMesh.list().peers[0]?.state === 'online')
      && source.ctx.developmentRooms.list().participants.some(item => item.id === receiver.humanId && item.presence === 'online'))
    await receiver.ctx.developmentRoomMesh.join({ roomId: task.hiddenRoomId, participantId: receiver.humanId })
    expect(source.ctx.developmentRooms.list().rooms.find(item => item.id === task.hiddenRoomId)?.participantIds)
      .toContain(receiver.humanId)
  })

  it('continues Room offline reconciliation and later callbacks after one channel fails', async () => {
    const source = await baseNode('node-offline-source')
    const receiver = await baseNode('node-offline-receiver')
    await startMesh(receiver, [peer(source, false)])
    await source.ctx.plugin(DevelopmentMeshWebSocketService, {
      ...config([peer(receiver, true)]), reconnectInitialDelayMs: 1_000, reconnectMaxDelayMs: 1_000,
    })
    const failure = vi.fn(async () => { throw new Error('one channel refused offline reconciliation') })
    const observed = vi.fn(async () => undefined)
    source.ctx.effect(() => source.ctx.developmentMesh.register('a-offline-failure/v1', {
      heads: () => ({}), read: () => [], receive: () => {}, peerOffline: failure,
    }))
    await source.ctx.plugin(DevelopmentRoomMeshService)
    source.ctx.effect(() => source.ctx.developmentMesh.register('z-offline-observer/v1', {
      heads: () => ({}), read: () => [], receive: () => {}, peerOffline: observed,
    }))
    await waitFor(() => source.ctx.developmentRooms.list().participants
      .some(item => item.id === receiver.humanId && item.presence === 'online'))
    await receiver.stopMesh?.()
    await waitFor(() => source.ctx.developmentRooms.list().participants
      .some(item => item.id === receiver.humanId && item.presence === 'offline') && observed.mock.calls.length > 0)
    expect(failure).toHaveBeenCalledExactlyOnceWith(receiver.nodeId)
    expect(observed).toHaveBeenCalledExactlyOnceWith(receiver.nodeId)
  })

  it('replicates a three-node Root/Fork/Merge DAG, routes owner commands, and resumes after disconnect', async () => {
    const first = await baseNode('node-a')
    const second = await baseNode('node-b')
    const third = await baseNode('node-c')
    await startThree(first, second, third)
    await waitFor(() => [first, second, third].every(node => node.ctx.developmentRooms.list().participants.length === 3))

    const root = await first.ctx.developmentTasks.create({
      origin: { kind: 'root' }, objective: 'Root delivery', scope: 'shared scope', createdBy: first.humanId,
    })
    const rootWithContext = await first.ctx.developmentTasks.publishContext({
      taskId: root.id, participantId: first.humanId, text: 'Explicit inherited context',
    })
    await Promise.all([waitForTask(second, root.id, 2), waitForTask(third, root.id, 2)])

    const firstFork = await second.ctx.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: root.id, revision: rootWithContext.revision } },
      objective: 'Fork B', scope: 'node B', createdBy: second.humanId,
    })
    const secondFork = await third.ctx.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: root.id, revision: rootWithContext.revision } },
      objective: 'Fork C', scope: 'node C', createdBy: third.humanId,
    })
    await Promise.all([
      waitForTask(first, firstFork.id), waitForTask(third, firstFork.id),
      waitForTask(first, secondFork.id), waitForTask(second, secondFork.id),
    ])

    const merged = await first.ctx.developmentTasks.create({
      origin: { kind: 'merge', parents: [
        { taskId: firstFork.id, revision: firstFork.revision },
        { taskId: secondFork.id, revision: secondFork.revision },
      ] },
      objective: 'Merged delivery', scope: 'combined', createdBy: first.humanId,
    })
    await Promise.all([waitForTask(second, merged.id), waitForTask(third, merged.id)])
    expect([first, second, third].map(node => node.ctx.developmentTasks.list({ limit: 128 }).length)).toEqual([4, 4, 4])
    expect(second.ctx.developmentTasks.contextView(firstFork.id).inherited?.sources[0]?.context)
      .toEqual([expect.objectContaining({ text: 'Explicit inherited context' })])

    const routed = await first.ctx.developmentTasks.publishContext({
      taskId: firstFork.id, participantId: second.humanId, text: 'Owner-routed update',
    })
    expect(routed.ownerNodeId).toBe(second.nodeId)
    await Promise.all([waitForTask(first, firstFork.id, 2), waitForTask(third, firstFork.id, 2)])

    await second.stopMesh?.()
    await waitFor(() => first.ctx.developmentMesh.list().peers.find(item => item.nodeId === second.nodeId)?.state === 'offline')
    expect(first.ctx.developmentTasks.get({ taskId: firstFork.id }).objective).toBe('Fork B')
    await expect(first.ctx.developmentTasks.publishContext({
      taskId: firstFork.id, participantId: second.humanId, text: 'Cannot mutate while owner is offline',
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })

    await startMesh(second, [peer(first, false), peer(third, true)])
    await waitFor(() => [first, second, third].every(node => node.ctx.developmentMesh.list().peers
      .filter(item => item.nodeId === second.nodeId || node === second).every(item => item.state === 'online')))
    const resumed = await first.ctx.developmentTasks.publishContext({
      taskId: firstFork.id, participantId: second.humanId, text: 'Mutation after reconnect',
    })
    expect(resumed.revision).toBe(3)
    await waitForTask(third, firstFork.id, 3)
  })

  it.each(['request', 'response'] as const)('keeps the connection usable after rejecting an oversized %s', async (direction) => {
    const source = await baseNode('size-source')
    const owner = await baseNode('size-owner')
    await startMesh(owner, [peer(source, false)])
    await startMesh(source, [peer(owner, true)])
    await waitFor(() => [source, owner].every(node => node.ctx.developmentMesh.list().peers[0]?.state === 'online'))
    const channelName = 'size-check/v1'
    for (const node of [source, owner]) {
      node.ctx.effect(() => node.ctx.developmentMesh.register(channelName, {
        heads: () => ({}), read: () => [], receive: () => {},
        command: payload => payload === 'large-response' ? 'x'.repeat(config([]).maxMessageBytes * 2) : 'next-command',
      }))
    }
    const offline: string[] = []
    for (const node of [source, owner]) {
      node.ctx.on('development-mesh/peer-changed', (value) => { if (value.state !== 'online') offline.push(value.state) })
    }
    const payload = direction === 'request' ? 'x'.repeat(config([]).maxMessageBytes * 2) : 'large-response'
    await expect(source.ctx.developmentMesh.command(owner.nodeId, channelName, payload)).rejects.toThrow('frame exceeds maxMessageBytes')
    await expect(source.ctx.developmentMesh.command(owner.nodeId, channelName, 'small-request')).resolves.toBe('next-command')
    expect(offline).toEqual([])
    expect([source, owner].map(node => node.ctx.developmentMesh.list().peers[0]?.state)).toEqual(['online', 'online'])
  })

  it('fails closed for missing, short, and mismatched shared secrets', async () => {
    const missing = await baseNode('node-missing', null)
    await expect(missing.ctx.plugin(DevelopmentMeshWebSocketService, config([]))).rejects.toThrow('is required')
    const short = await baseNode('node-short', 'too-short')
    await expect(short.ctx.plugin(DevelopmentMeshWebSocketService, config([]))).rejects.toThrow('at least 32')

    const first = await baseNode('node-good', SHARED_SECRET)
    const second = await baseNode('node-wrong', 'another-mismatched-secret-that-is-long-enough')
    await startMesh(second, [peer(first, false)])
    await startMesh(first, [peer(second, true)])
    await waitFor(() => first.ctx.developmentMesh.list().peers[0]?.lastError !== undefined)
    expect(first.ctx.developmentMesh.list().peers[0]).toMatchObject({ state: 'offline' })
    expect(first.ctx.developmentMesh.list().clusterId).not.toBe(second.ctx.developmentMesh.list().clusterId)
    expect(JSON.stringify(first.ctx.developmentMesh.list())).not.toContain(SHARED_SECRET)
  })

  it('closes an established configured peer when discovery initialization fails', async () => {
    const owner = await baseNode('node-startup-owner')
    const source = await baseNode('node-startup-source')
    await startMesh(owner, [peer(source, false)])
    const entered = Promise.withResolvers<undefined>()
    const failure = Promise.withResolvers<undefined>()
    const start = vi.spyOn(LanPeerDiscovery.prototype, 'start').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await failure.promise
    })
    const starting = source.ctx.plugin(DevelopmentMeshWebSocketService, {
      ...config([peer(owner, true)]), discovery: { ...discovery, enabled: true },
    })
    const rejected = expect(starting).rejects.toThrow('discovery setup refused')
    let service: DevelopmentMeshWebSocketService | undefined
    try {
      await entered.promise
      const observed = source.ctx.developmentMesh
      if (!(observed instanceof DevelopmentMeshWebSocketService)) throw new Error('Mesh startup instance is missing')
      service = observed
      await waitFor(() => owner.ctx.developmentMesh.list().peers[0]?.state === 'online')
      failure.reject(new Error('discovery setup refused'))
      await rejected
      await source.ctx.fiber.dispose()
      await waitFor(() => owner.ctx.developmentMesh.list().peers[0]?.state === 'offline',
        () => owner.ctx.developmentMesh.list())
    } finally {
      failure.reject(new Error('discovery setup refused'))
      await Promise.resolve(starting).catch(() => undefined)
      // Failure cleanup must also reclaim sockets when startup never installs its disposer.
      if (service !== undefined) {
        const close: unknown = Reflect.get(service, 'close')
        if (typeof close === 'function') await Reflect.apply(close, service, [])
      }
      start.mockRestore()
    }
  })

  it('rejects tampered and replayed envelopes and isolates replica conflicts', async () => {
    const tamper = await baseNode('node-tamper')
    await startMesh(tamper, [{ nodeId: 'attacker-node', url: 'ws://127.0.0.1:1', connect: false }])
    const tamperedSocket = await rawConnect(tamper)
    await introduce(tamper, tamperedSocket)
    const valid = JSON.parse(envelope(tamper, 2, { type: 'pull', channel: 'unknown/v1', heads: {} })) as { payload: string; mac: string }
    tamperedSocket.send(JSON.stringify({ ...valid, mac: '0'.repeat(64) }))
    await waitFor(() => tamper.ctx.developmentMesh.list().peers[0]?.state === 'offline')
    expect(tamper.ctx.developmentMesh.list().peers[0]?.lastError).toContain('invalid envelope HMAC')

    const replay = await baseNode('node-replay')
    await startMesh(replay, [{ nodeId: 'attacker-node', url: 'ws://127.0.0.1:1', connect: false }])
    const replaySocket = await rawConnect(replay)
    await introduce(replay, replaySocket)
    const repeated = envelope(replay, 2, { type: 'pull', channel: 'unknown/v1', heads: {} })
    replaySocket.send(repeated)
    replaySocket.send(repeated)
    await waitFor(() => replay.ctx.developmentMesh.list().peers[0]?.state === 'offline')
    expect(replay.ctx.developmentMesh.list().peers[0]?.lastError).toContain('replayed or out-of-order envelope')

    const conflict = await baseNode('node-conflict')
    await startMesh(conflict, [{ nodeId: 'attacker-node', url: 'ws://127.0.0.1:1', connect: false }])
    conflict.ctx.developmentMesh.register('conflict/v1', {
      heads: () => ({}),
      read: () => [],
      receive: () => { throw Object.assign(new Error('same event id has different content'), { code: 'REPLICA_CONFLICT' }) },
    })
    const conflictSocket = await rawConnect(conflict)
    await introduce(conflict, conflictSocket)
    conflictSocket.send(envelope(conflict, 2, { type: 'events', channel: 'conflict/v1', events: [{}] }))
    await waitFor(() => conflict.ctx.developmentMesh.list().peers[0]?.state === 'isolated')
    expect(conflict.ctx.developmentMesh.list().peers[0]).toMatchObject({ state: 'isolated', conflicts: 1 })
    expect(conflict.ctx.developmentMesh.list().peers[0]?.lastError).toContain('REPLICA_CONFLICT')
  })

  it('enforces deterministic topology and protocol resource bounds', async () => {
    expect(isMulticastAddress('239.255.73.67')).toBe(true)
    expect(isMulticastAddress('224.0.0.251')).toBe(false)
    expect(ownsDial('node-a' as DevelopmentNodeId, 'node-b' as DevelopmentNodeId)).toBe(true)
    const boundsNode = await baseNode('node-bounds')
    expect(() => new DevelopmentMeshWebSocketService(boundsNode.ctx, {
      ...config([]), discovery: { ...discovery, maxDatagramBytes: 65_508 },
    })).toThrow('must not exceed 65507')
    const selfNode = await baseNode('node-self')
    expect(() => new DevelopmentMeshWebSocketService(selfNode.ctx, {
      ...config([{ nodeId: selfNode.nodeId, url: `ws://127.0.0.1:${String(selfNode.ctx.webServer.port)}`, connect: false }]),
    })).toThrow('cannot list itself')
  })
})
