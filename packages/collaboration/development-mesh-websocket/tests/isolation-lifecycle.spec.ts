/** Isolated authenticated peers must lose their live Room presence. */
import { createHmac, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Rooms, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import Tasks from '@deepseek-ai/dsh-development-task'
import { developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import WebSocket from 'ws'
import { afterEach, expect, it } from 'vitest'
import Mesh from '../src/index.ts'
import RoomMesh from '../../development-room-mesh/src/index.ts'
import TaskMesh from '../../development-task-mesh/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const secret = 'isolation-test-secret-with-at-least-thirty-two-bytes'
const path = '/internal/development-mesh'
const contexts: Context[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.CLOSED) continue
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    socket.terminate()
    await closed
  }
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function node(nodeId: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Rooms, { nodeId, presenceTtlMs: 60_000, maxParticipants: 16, maxRooms: 16, maxTextBytes: 2048 })
  await ctx.plugin(Tasks, { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 8, maxContextBlockBytes: 65536,
    maxLineageTasks: 32, roomRetryIntervalMs: 10_000, maxTextBytes: 8192 })
  const humanId = `human-${nodeId}` as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: humanId, kind: 'human', displayName: nodeId })
  return { ctx, nodeId: ctx.developmentRooms.list().nodeId, humanId }
}

function signature(value: string) { return createHmac('sha256', secret).update(value).digest('hex') }

it.each(['presence', 'reconnect', 'closing-command'] as const)('preserves %s isolation after a conflicting Task event', async (check) => {
  const source = await node('isolated-source')
  const receiver = await node('isolated-receiver')
  const task = await source.ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Original objective',
    scope: 'source responsibility', createdBy: source.humanId })
  const original = source.ctx.developmentTasks.log()[0]
  if (original?.change.kind !== 'task-created') throw new Error('Missing original Task event')
  const presence = source.ctx.developmentRooms.list().participants.find(item => item.id === source.humanId)
  if (presence === undefined) throw new Error('Missing original participant')
  const conflicting = developmentTaskEventSchema.parse({ ...original, change: { ...original.change, objective: 'Conflicting objective' } })
  await receiver.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await receiver.ctx.plugin(MemoryCredentials, { TEST_MESH_SECRET: secret })
  await receiver.ctx.plugin(Mesh, { path, secretRef: 'TEST_MESH_SECRET',
    peers: [{ nodeId: source.nodeId, url: 'ws://127.0.0.1:1', connect: false }],
    discovery: { enabled: false, cluster: 'isolation-test', multicastAddress: '239.255.73.67', port: 45892,
      announceIntervalMs: 50, peerTtlMs: 200, maxDatagramBytes: 2048 },
    reconnectInitialDelayMs: 20, reconnectMaxDelayMs: 100, commandTimeoutMs: 1000,
    maxMessageBytes: 256 * 1024, maxEventsPerFrame: 4096 })
  await receiver.ctx.plugin(RoomMesh)
  await receiver.ctx.plugin(TaskMesh)

  const connect = () => {
    const at = Date.now()
    const nonce = randomUUID()
    const socket = new WebSocket(`ws://127.0.0.1:${String(receiver.ctx.webServer.port)}${path}`, { headers: {
      'x-dsh-mesh-node': source.nodeId, 'x-dsh-mesh-target': receiver.nodeId,
      'x-dsh-mesh-nonce': nonce, 'x-dsh-mesh-at': String(at),
      'x-dsh-mesh-mac': signature(`${source.nodeId}\n${receiver.nodeId}\n${nonce}\n${String(at)}\n${path}`),
    } })
    sockets.push(socket)
    return socket
  }
  const socket = connect()
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (seq: number, body: unknown) => {
    const payload = Buffer.from(JSON.stringify({ version: 1, nodeId: source.nodeId, targetNodeId: receiver.nodeId,
      nonce: randomUUID(), seq, at: Date.now(), body })).toString('base64url')
    socket.send(JSON.stringify({ payload, mac: signature(payload) }))
  }
  send(1, { type: 'hello' })
  send(2, { type: 'events', channel: 'development-room/v1', events: [{ kind: 'presence', participant: presence }] })
  send(3, { type: 'events', channel: 'development-task/v1', events: [{ kind: 'task-event', entry: original }] })
  await expect.poll(() => receiver.ctx.developmentRooms.list().participants.find(item => item.id === source.humanId)?.presence).toBe('online')
  await expect.poll(() => receiver.ctx.developmentTasks.list({ limit: 16 }).find(item => item.id === task.id)?.objective).toBe('Original objective')

  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  let closingCommands = 0
  if (check === 'closing-command') {
    receiver.ctx.effect(() => receiver.ctx.developmentMesh.register('isolation-command', {
      heads: () => ({}), read: () => [], receive: () => {},
      command: () => { closingCommands++; return null },
    }))
    // Send through the live client socket after isolation, before it receives the server's close frame.
    receiver.ctx.on('development-mesh/peer-changed', (peer) => {
      if (peer.state === 'isolated') {
        send(5, { type: 'command', channel: 'isolation-command', commandId: randomUUID(), payload: null })
      }
    })
  }
  send(4, { type: 'events', channel: 'development-task/v1', events: [{ kind: 'task-event', entry: conflicting }] })
  await closed
  expect(receiver.ctx.developmentMesh.list().peers[0]).toMatchObject({ state: 'isolated', conflicts: 1 })
  expect(receiver.ctx.developmentTasks.get({ taskId: task.id }).objective).toBe('Original objective')
  if (check === 'presence') {
    await expect.poll(() => receiver.ctx.developmentRooms.list().participants.find(item => item.id === source.humanId)?.presence).toBe('offline')
  } else if (check === 'reconnect') {
    const retry = connect()
    const status = await new Promise<number>((resolve, reject) => {
      retry.once('open', () => { resolve(101) })
      retry.once('error', reject)
      retry.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
        retry.terminate()
      })
    })
    expect(status).toBe(403)
    expect(receiver.ctx.developmentMesh.list().peers[0]).toMatchObject({ state: 'isolated', conflicts: 1 })
    expect(receiver.ctx.developmentTasks.get({ taskId: task.id }).objective).toBe('Original objective')
  } else expect(closingCommands).toBe(0)
})
