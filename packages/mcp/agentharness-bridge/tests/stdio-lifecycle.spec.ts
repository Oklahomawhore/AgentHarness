/** Real MCP framing over owned streams, with Host fetches and launcher readiness controlled by the fixture. */
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/stdio.ts'
import { connectionOptions } from './connection.ts'

interface OwnedIo { input: PassThrough; output: PassThrough; transport?: StdioServerTransport }
let io: OwnedIo | undefined

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/stdio.js')>()
  return { ...actual, StdioServerTransport: class extends actual.StdioServerTransport {
    constructor() {
      const owned = io
      if (owned === undefined) throw new Error('Missing owned stdio streams')
      super(owned.input, owned.output)
      owned.transport = this
    }
  } }
})

const originalInternals = { ...internals }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  try { await Promise.all(closers.splice(0).map(close => close())) }
  finally { Object.assign(internals, originalInternals); vi.restoreAllMocks(); io = undefined }
})

async function fixture(args: readonly string[] = []) {
  const owned: OwnedIo = { input: new PassThrough(), output: new PassThrough() }
  io = owned
  const ctx = new Context()
  const lines = createInterface({ input: owned.output })
  const messages: string[] = []
  lines.on('line', (line) => { messages.push(line) })
  let closing: Promise<void> | undefined
  const dispose = () => closing ??= (async () => {
    try { await ctx.fiber.dispose() }
    finally {
      lines.close()
      const closed = [once(owned.input, 'close'), once(owned.output, 'close')]
      owned.input.destroy()
      owned.output.destroy()
      await Promise.all(closed)
    }
  })()
  closers.push(dispose)
  const calls: string[] = []
  const announced = Promise.withResolvers<undefined>()
  const options = await connectionOptions(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected authenticated RPC JSON')
    const request = JSON.parse(init.body) as { method: string; rpcId: string }
    calls.push(request.method)
    if (request.method === 'developmentRooms/announce') announced.resolve(undefined)
    const value = request.method === 'developmentTasks/list' ? [] : { presenceTtlMs: 1500 }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
  })
  const fetcher = options.fetch
  if (fetcher === undefined) throw new Error('Missing authenticated fetch fixture')
  const originalFetch = globalThis.fetch.bind(globalThis)
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    return url.origin === 'http://127.0.0.1:3080' ? fetcher(input, init) : originalFetch(input, init)
  })
  const listeners = new Set<() => void>()
  let ready = false
  const exits: number[] = []
  provideCmdline(ctx, { args, exit: (code) => { exits.push(code) }, ready: {
    onReady: (listener) => {
      if (ready) listener()
      else listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } })
  internals.stdin = owned.input
  const config: Config = {
    connectionPath: options.connectionPath, requestTimeoutMs: options.requestTimeoutMs,
    maxDescriptorBytes: options.maxDescriptorBytes, maxRequestBytes: options.maxRequestBytes, maxResponseBytes: options.maxResponseBytes,
    participantId: 'stdio-agent', displayName: 'Stdio Agent',
    leaseRetryMs: 250, leaseMinHeartbeatMs: 500, leaseMaxHeartbeatMs: 5000,
  }
  const commitReady = () => {
    ready = true
    const pending = [...listeners]
    listeners.clear()
    for (const listener of pending) listener()
  }
  const request = async (id: number, method: string, params: Record<string, unknown>) => {
    owned.input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    const matching = () => messages.find(line => (JSON.parse(line) as { id?: number }).id === id)
    await expect.poll(matching).toBeDefined()
    return JSON.parse(matching()!) as unknown
  }
  return { ctx, owned, calls, announced, exits, listeners, config, commitReady, request, dispose }
}

describe('MCP stdio lifecycle', () => {
  it('settles transport startup failure before disposing partially acquired resources', async () => {
    const f = await fixture()
    const starting = vi.spyOn(StdioServerTransport.prototype, 'start').mockRejectedValueOnce(new Error('stdio startup refused'))
    try {
      await expect(apply(f.ctx, f.config)).rejects.toThrow('stdio startup refused')
      await f.dispose()
      f.commitReady()
      expect(f.calls).toEqual([])
      expect(f.exits).toEqual([])
      expect(f.owned.input.listenerCount('data')).toBe(0)
      expect(f.owned.input.listenerCount('end')).toBe(0)
    } finally { starting.mockRestore(); await f.dispose() }
  })

  it('waits for an opening transport during disposal and never announces after it finishes', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the opening transport below.
    const original = StdioServerTransport.prototype.start
    const starting = vi.spyOn(StdioServerTransport.prototype, 'start').mockImplementationOnce(async function (this: StdioServerTransport) {
      await Reflect.apply(original, this, [])
      entered.resolve(undefined)
      await release.promise
    })
    const closing = vi.spyOn(StdioServerTransport.prototype, 'close')
    const opening = apply(f.ctx, f.config)
    let settled = false
    try {
      await entered.promise
      const disposing = f.dispose().then(() => { settled = true })
      await expect.poll(() => f.owned.input.listenerCount('end')).toBe(0)
      expect(settled).toBe(false)
      expect(closing).not.toHaveBeenCalled()
      release.resolve(undefined)
      await Promise.all([opening, disposing])
      f.commitReady()
      expect(f.calls).toEqual([])
      expect(f.listeners.size).toBe(0)
      expect(f.exits).toEqual([])
    } finally {
      release.resolve(undefined)
      await opening.catch(() => undefined)
      starting.mockRestore()
      await f.dispose()
      closing.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('withdraws presence and reports cleanup failure when the transport close acknowledgement rejects', async () => {
    const f = await fixture()
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply retains the actual transport cleanup below.
    const original = StdioServerTransport.prototype.close
    const errors = vi.spyOn(f.ctx.logger, 'error')
    const closing = vi.spyOn(StdioServerTransport.prototype, 'close').mockImplementationOnce(async function (this: StdioServerTransport) {
      await Reflect.apply(original, this, [])
      throw new Error('stdio close acknowledgement lost')
    })
    try {
      await apply(f.ctx, f.config)
      f.commitReady()
      await f.announced.promise
      await f.dispose()
      expect(f.calls.at(-1)).toBe('developmentRooms/withdraw')
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'MCP stdio cleanup failed' }))
      expect(f.owned.input.listenerCount('data')).toBe(0)
      expect(f.exits).toEqual([])
    } finally { closing.mockRestore(); errors.mockRestore(); await f.dispose() }
  })

  it.skipIf(process.platform === 'win32')('serves protocol frames before readiness, then announces and withdraws without retaining stdin listeners', async () => {
    const f = await fixture(['--url', 'http://127.0.0.1:3080'])
    try {
      await apply(f.ctx, f.config)
      expect(f.calls).toEqual([])
      expect(await f.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'owned-stream-client', version: '1' } })).toMatchObject({ id: 1, result: { serverInfo: { name: 'agentharness' } } })
      f.owned.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      f.commitReady()
      await f.announced.promise
      expect(await f.request(2, 'tools/call', { name: 'agentharness_task_list', arguments: {} }))
        .toMatchObject({ id: 2, result: { structuredContent: { items: [] } } })
      await f.dispose()
      expect(f.calls.at(-1)).toBe('developmentRooms/withdraw')
      expect(f.owned.input.listenerCount('data')).toBe(0)
      expect(f.owned.input.listenerCount('error')).toBe(0)
      expect(f.owned.input.listenerCount('end')).toBe(0)
      expect(f.listeners.size).toBe(0)
      expect(f.exits).toEqual([])
    } finally { await f.dispose() }
  })

  it('cancels deferred transport-close and presence callbacks when disposed before readiness', async () => {
    const f = await fixture()
    try {
      await apply(f.ctx, f.config)
      await f.owned.transport?.close()
      expect(f.exits).toEqual([])
      await f.dispose()
      f.commitReady()
      expect(f.calls).toEqual([])
      expect(f.exits).toEqual([])
      expect(f.listeners.size).toBe(0)
    } finally { await f.dispose() }
  })

  it.skipIf(process.platform === 'win32')('requests bounded launcher exit when the ready protocol transport closes', async () => {
    const f = await fixture()
    try {
      await apply(f.ctx, f.config)
      f.commitReady()
      await f.announced.promise
      await f.owned.transport?.close()
      expect(f.exits).toEqual([0])
      await f.dispose()
      expect(f.calls.at(-1)).toBe('developmentRooms/withdraw')
    } finally { await f.dispose() }
  })
})
