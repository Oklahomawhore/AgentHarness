/** UDP boundary failures must not make a bound discovery listener depend on its first datagram. */
import { EventEmitter } from 'node:events'
import { createSocket, type Socket } from 'node:dgram'
import { createHmac, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Rooms from '@deepseek-ai/dsh-development-room'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, vi } from 'vitest'
import { isMulticastAddress, LanPeerDiscovery, type LanDiscoveryConfig } from '../src/discovery.ts'
import Mesh, { type PeerConfig } from '../src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

vi.mock('node:dgram', () => ({ createSocket: vi.fn() }))

class DatagramSocket extends EventEmitter {
  readonly sent: Buffer[] = []
  sendError: Error | null = null
  bindError: Error | undefined
  membershipError: unknown
  sendThrow: unknown
  closeError: NodeJS.ErrnoException | undefined
  closed = false
  joined = false

  bind() { queueMicrotask(() => { this.emit(this.bindError === undefined ? 'listening' : 'error', this.bindError) }) }
  addMembership() { if (this.membershipError !== undefined) throw this.membershipError; this.joined = true }
  setMulticastLoopback() {}
  setMulticastTTL() {}
  dropMembership() { this.joined = false }
  close(callback: () => void) {
    if (this.closeError !== undefined) throw this.closeError
    this.closed = true
    queueMicrotask(callback)
  }
  send(bytes: Buffer, _port: number, _address: string, callback: (error: Error | null) => void) {
    if (this.sendThrow !== undefined) throw this.sendThrow
    this.sent.push(Buffer.from(bytes))
    queueMicrotask(() => { callback(this.sendError) })
  }
}

const active: LanPeerDiscovery[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const discovery of active.splice(0)) await discovery.close()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function provider(nodeId: string, peers: PeerConfig[] = [], maxMessageBytes = 256 * 1024) {
  const ctx = new Context()
  contexts.push(ctx)
  const socket = new DatagramSocket()
  // Only multicast is replaced; endpoint authentication uses real loopback WebSockets.
  vi.mocked(createSocket).mockReturnValueOnce(socket as unknown as Socket)
  await ctx.plugin(Rooms, { nodeId, presenceTtlMs: 10000, maxParticipants: 16, maxRooms: 16, maxTextBytes: 2048 })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const secret = 'provider-discovery-secret-with-at-least-32-bytes'
  await ctx.plugin(MemoryCredentials, { TEST_MESH_SECRET: secret })
  await ctx.plugin(Mesh, { path: '/mesh', secretRef: 'TEST_MESH_SECRET', peers,
    discovery: { enabled: true, cluster: 'provider-test', multicastAddress: '239.255.73.67', port: 45892,
      announceIntervalMs: 10000, peerTtlMs: 30000, maxDatagramBytes: 2048 },
    reconnectInitialDelayMs: 1000, reconnectMaxDelayMs: 1000, commandTimeoutMs: 1000,
    maxMessageBytes, maxEventsPerFrame: 4096 })
  const send = (changes: Readonly<Record<string, unknown>>) => {
    socket.emit('message', peerPacket(Buffer.from(secret), {
      clusterId: ctx.developmentMesh.list().clusterId, path: '/mesh', ...changes,
    }), { address: '127.0.0.1' })
  }
  return { ctx, socket, send }
}

it('connects discovered endpoints, preserves configured topology and removes authenticated departed peers', async () => {
  const configured = { nodeId: 'node-c', url: 'ws://127.0.0.1:1', connect: false }
  const first = await provider('node-a', [configured])
  const second = await provider('node-b')
  const firstInstance = randomUUID()
  const secondInstance = randomUUID()
  const firstAnnouncement = { nodeId: 'node-a', port: first.ctx.webServer.port, instanceId: firstInstance }
  const secondAnnouncement = { nodeId: 'node-b', port: second.ctx.webServer.port, instanceId: secondInstance }
  first.send(secondAnnouncement)
  second.send(firstAnnouncement)
  await expect.poll(() => first.ctx.developmentMesh.list().peers.find(peer => peer.nodeId === 'node-b')?.state).toBe('online')
  await expect.poll(() => second.ctx.developmentMesh.list().peers[0]?.state).toBe('online')
  const handled = vi.fn((value: unknown) => value)
  second.ctx.effect(() => second.ctx.developmentMesh.register('discovered-command/v1', {
    heads: () => ({}), read: () => [], receive: () => {}, command: handled,
  }))
  await expect(first.ctx.developmentMesh.command('node-b' as DevelopmentNodeId, 'discovered-command/v1', 'discovered'))
    .resolves.toBe('discovered')
  expect(handled).toHaveBeenCalledExactlyOnceWith('discovered', 'node-a')

  first.send({ ...secondAnnouncement, port: first.ctx.webServer.port })
  const configuredAnnouncement = { nodeId: 'node-c', port: second.ctx.webServer.port, instanceId: randomUUID() }
  first.send(configuredAnnouncement)
  first.send({ ...configuredAnnouncement, state: 'offline' })
  first.socket.emit('error', new Error('one multicast receive error'))
  first.send({ nodeId: 'node-a', port: first.ctx.webServer.port })
  expect(first.ctx.developmentMesh.list().peers).toEqual([
    expect.objectContaining({ nodeId: 'node-c', state: 'offline', direction: 'accept' }),
    expect.objectContaining({ nodeId: 'node-b', state: 'online', direction: 'dial' }),
  ])

  first.send({ ...secondAnnouncement, state: 'offline' })
  await expect.poll(() => second.ctx.developmentMesh.list().peers[0]?.state).toBe('offline')
  second.send({ ...firstAnnouncement, state: 'offline' })
  expect(first.ctx.developmentMesh.list().peers).toEqual([expect.objectContaining({ nodeId: 'node-c', state: 'offline' })])
  expect(second.ctx.developmentMesh.list().peers).toEqual([])
})

it('rejects a discovered identity whose complete hello exceeds the byte budget and continues discovery', async () => {
  const node = await provider('node-z', [], 400)
  node.send({ nodeId: 'p'.repeat(200), port: node.ctx.webServer.port })
  expect(node.ctx.developmentMesh.list().peers).toEqual([])
  expect(node.socket.closed).toBe(false)
  node.send({ nodeId: 'node-a', port: node.ctx.webServer.port })
  expect(node.ctx.developmentMesh.list().peers).toEqual([
    expect.objectContaining({ nodeId: 'node-a', state: 'offline', direction: 'accept' }),
  ])
})

it('cancels a failed discovered peer\'s pending reconnect when its authenticated goodbye arrives', async () => {
  const node = await provider('node-a')
  const instanceId = randomUUID()
  const offline = Promise.withResolvers<undefined>()
  node.ctx.on('development-mesh/peer-changed', (peer) => {
    if (peer.nodeId === 'node-z' && peer.state === 'offline' && peer.lastError !== undefined) offline.resolve(undefined)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const baseline = vi.getTimerCount()
    node.send({ nodeId: 'node-z', port: node.ctx.webServer.port, instanceId })
    await offline.promise
    expect(vi.getTimerCount()).toBe(baseline + 1)
    node.send({ nodeId: 'node-z', port: node.ctx.webServer.port, instanceId, state: 'offline' })
    expect(node.ctx.developmentMesh.list().peers).toEqual([])
    expect(vi.getTimerCount()).toBe(baseline)
    await vi.advanceTimersByTimeAsync(5000)
    expect(node.ctx.developmentMesh.list().peers).toEqual([])
  } finally {
    await node.ctx.fiber.dispose()
    vi.useRealTimers()
  }
})

function fixture(overrides: Partial<LanDiscoveryConfig> = {}) {
  const socket = new DatagramSocket()
  // This fake implements the UDP methods used by discovery, with no host port or multicast membership.
  vi.mocked(createSocket).mockReturnValue(socket as unknown as Socket)
  const config: LanDiscoveryConfig = { enabled: true, cluster: 'test-cluster', multicastAddress: '239.255.73.67',
    port: 45892, announceIntervalMs: 100, peerTtlMs: 300, maxDatagramBytes: 2048, ...overrides }
  const callbacks = { up: vi.fn(), down: vi.fn(), collision: vi.fn(), error: vi.fn() }
  const secret = Buffer.from('test-discovery-secret-with-at-least-32-bytes')
  const discovery = new LanPeerDiscovery(config, 'node-a' as DevelopmentNodeId, 43100,
    '/mesh', 'test-cluster-id', secret, callbacks)
  active.push(discovery)
  return { discovery, socket, callbacks, secret }
}

function peerPacket(secret: Buffer, changes: Readonly<Record<string, unknown>> = {}) {
  const announcement = { product: 'agentharness-mesh', version: 1, clusterId: 'test-cluster-id',
    instanceId: randomUUID(), nodeId: 'node-b', port: 43101, path: '/mesh', state: 'online', at: Date.now(), nonce: randomUUID(),
    ...changes }
  return Buffer.from(JSON.stringify({ announcement,
    mac: createHmac('sha256', secret).update(JSON.stringify(announcement)).digest('hex') }))
}

it('keeps discovery listening after an initial unreachable datagram and announces on the existing interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const { discovery, socket, callbacks, secret } = fixture()
  const unavailable = Object.assign(new Error('send EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
  socket.sendError = unavailable
  await expect(discovery.start()).resolves.toBeUndefined()
  expect(callbacks.error).toHaveBeenCalledExactlyOnceWith(unavailable)
  expect(socket.closed).toBe(false)
  expect(socket.joined).toBe(true)

  socket.emit('message', peerPacket(secret), { address: '192.0.2.2' })
  expect(callbacks.up).toHaveBeenCalledExactlyOnceWith({ nodeId: 'node-b', address: '192.0.2.2', port: 43101 })
  socket.sendError = null
  await vi.advanceTimersByTimeAsync(100)
  expect(socket.sent).toHaveLength(2)
  expect(callbacks.error).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(300)
  expect(callbacks.down).toHaveBeenCalledExactlyOnceWith('node-b')
  await discovery.close()
  expect(socket.closed).toBe(true)
  expect(socket.joined).toBe(false)
  const count = socket.sent.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(socket.sent).toHaveLength(count)
  expect(JSON.parse(socket.sent.at(-1)!.toString())).toMatchObject({ announcement: { state: 'offline' } })
})

it.each(['bind', 'membership', 'datagram size'] as const)('rejects %s failure before starting periodic discovery', async (failure) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const { discovery, socket } = fixture(failure === 'datagram size' ? { maxDatagramBytes: 1 } : {})
  if (failure === 'bind') socket.bindError = new Error('bind failed')
  if (failure === 'membership') socket.membershipError = new Error('membership failed')
  await expect(discovery.start()).rejects.toThrow(failure === 'datagram size' ? 'maxDatagramBytes' : `${failure} failed`)
  expect(socket.closed).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(socket.sent).toEqual([])
})

it('does not bind when disabled and starts an active discovery instance only once', async () => {
  expect(isMulticastAddress('::1')).toBe(false)
  const disabled = fixture({ enabled: false })
  await disabled.discovery.start()
  await disabled.discovery.close()
  expect(createSocket).not.toHaveBeenCalled()
  const enabled = fixture()
  await enabled.discovery.start()
  await enabled.discovery.start()
  expect(createSocket).toHaveBeenCalledTimes(1)
  expect(enabled.socket.sent).toHaveLength(1)
})

it('reports a periodic byte-limit error and still closes when the clock changes the announcement size', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const sample = fixture()
  await sample.discovery.start()
  const maxDatagramBytes = sample.socket.sent[0]!.byteLength
  await sample.discovery.close()
  const { discovery, socket, callbacks } = fixture({ maxDatagramBytes })
  await discovery.start()
  vi.setSystemTime(10 ** 13)
  await vi.advanceTimersByTimeAsync(100)
  expect(callbacks.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: 'development-mesh discovery announcement exceeds maxDatagramBytes',
  }))
  expect(socket.sent).toHaveLength(1)
  await discovery.close()
  expect(socket.closed).toBe(true)
})

it('reports Error objects when the UDP implementation throws a non-Error value', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const failed = fixture()
  failed.socket.membershipError = 'membership failed'
  await expect(failed.discovery.start()).rejects.toThrow('membership failed')
  const { discovery, socket, callbacks } = fixture()
  await discovery.start()
  socket.sendThrow = 'UDP send failed'
  await vi.advanceTimersByTimeAsync(100)
  expect(callbacks.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'UDP send failed' }))
  expect(callbacks.error.mock.calls[0]![0]).toBeInstanceOf(Error)
})

it.each([
  ['unknown field', { extra: true }], ['wrong product', { product: 'other' }], ['wrong version', { version: 2 }],
  ['wrong cluster', { clusterId: 'other-cluster' }], ['wrong path', { path: '/other' }],
  ['old clock', { at: 0 }], ['future clock', { at: Number.MAX_SAFE_INTEGER }],
  ['invalid port', { port: 0 }], ['invalid node id', { nodeId: '../node-b' }],
] as const)('ignores an authenticated packet with %s', async (_label, changes) => {
  const { discovery, socket, callbacks, secret } = fixture()
  await discovery.start()
  socket.emit('message', peerPacket(secret, changes), { address: '192.0.2.2' })
  expect(callbacks.up).not.toHaveBeenCalled()
  expect(callbacks.down).not.toHaveBeenCalled()
  expect(callbacks.collision).not.toHaveBeenCalled()
})

it('rejects malformed, oversized, unauthenticated and non-IPv4 datagrams', async () => {
  const { discovery, socket, callbacks, secret } = fixture()
  await discovery.start()
  for (const bytes of [Buffer.from('{'), Buffer.alloc(2049), peerPacket(Buffer.from('wrong-secret'))]) {
    socket.emit('message', bytes, { address: '192.0.2.2' })
  }
  socket.emit('message', peerPacket(secret), { address: '::1' })
  socket.emit('message', socket.sent[0], { address: '192.0.2.1' })
  expect(callbacks.up).not.toHaveBeenCalled()
  expect(callbacks.collision).not.toHaveBeenCalled()
  const sameId = peerPacket(secret, { nodeId: 'node-a' })
  socket.emit('message', sameId, { address: '192.0.2.2' })
  socket.emit('message', sameId, { address: '192.0.2.2' })
  expect(callbacks.collision).toHaveBeenCalledExactlyOnceWith('node-a')
  socket.emit('error', new Error('UDP socket error'))
  expect(callbacks.error).toHaveBeenCalledOnce()
  await discovery.close()
  socket.emit('message', peerPacket(secret), { address: '192.0.2.2' })
  expect(callbacks.up).not.toHaveBeenCalled()
})

it('changes the peer only for a new endpoint or process and accepts goodbye only from its retained process', async () => {
  const { discovery, socket, callbacks, secret } = fixture()
  await discovery.start()
  const instanceId = randomUUID()
  const receive = (changes: Readonly<Record<string, unknown>>) => {
    socket.emit('message', peerPacket(secret, { instanceId, ...changes }), { address: '192.0.2.2' })
  }
  receive({ state: 'offline' })
  expect(callbacks.down).not.toHaveBeenCalled()
  receive({})
  receive({})
  expect(callbacks.up).toHaveBeenCalledTimes(1)
  receive({ port: 43102 })
  expect(callbacks.up).toHaveBeenCalledTimes(2)
  receive({ state: 'offline', instanceId: randomUUID() })
  expect(callbacks.down).not.toHaveBeenCalled()
  receive({ instanceId: randomUUID() })
  expect(callbacks.collision).toHaveBeenCalledExactlyOnceWith('node-b')
  expect(callbacks.up).toHaveBeenCalledTimes(3)
  receive({})
  receive({ state: 'offline' })
  expect(callbacks.down).toHaveBeenCalledExactlyOnceWith('node-b')
})

it('removes expired replay nonces and rediscovers a peer with fresh authenticated time', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const { discovery, socket, callbacks, secret } = fixture()
  await discovery.start()
  const nonce = randomUUID()
  socket.emit('message', peerPacket(secret, { nonce }), { address: '192.0.2.2' })
  await vi.advanceTimersByTimeAsync(30_001)
  socket.emit('message', peerPacket(secret), { address: '192.0.2.3' })
  socket.emit('message', peerPacket(secret, { nonce }), { address: '192.0.2.2' })
  expect(callbacks.up).toHaveBeenCalledTimes(3)
})

it.each(['ERR_SOCKET_DGRAM_NOT_RUNNING', 'EIO'])('settles a socket close with %s', async (code) => {
  const { discovery, socket } = fixture()
  await discovery.start()
  socket.closeError = Object.assign(new Error('socket close failed'), { code })
  if (code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') await expect(discovery.close()).resolves.toBeUndefined()
  else await expect(discovery.close()).rejects.toBe(socket.closeError)
})
