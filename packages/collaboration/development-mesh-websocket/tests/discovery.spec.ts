/** UDP boundary failures must not make a bound discovery listener depend on its first datagram. */
import { EventEmitter } from 'node:events'
import { createSocket, type Socket } from 'node:dgram'
import { createHmac, randomUUID } from 'node:crypto'
import type { DevelopmentNodeId } from '@deepseek-ai/dsh-development-room'
import { afterEach, expect, it, vi } from 'vitest'
import { isMulticastAddress, LanPeerDiscovery, type LanDiscoveryConfig } from '../src/discovery.ts'

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
afterEach(async () => {
  for (const discovery of active.splice(0)) await discovery.close()
  vi.useRealTimers()
  vi.clearAllMocks()
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
