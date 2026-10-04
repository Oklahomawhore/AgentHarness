import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHarnessBridgePresenceLease } from '../src/index.ts'
import { connectionOptions } from './connection.ts'

afterEach(() => {
  vi.useRealTimers()
})

function response(rpcId: string, value: unknown, ok = true): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: ok ? { ok: true, value } : { ok: false, error: { code: 'NOT_READY', message: 'restart' } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function requestBody(init: RequestInit | undefined): { method: string; rpcId: string } {
  const parsed: unknown = JSON.parse(init?.body as string)
  if (typeof parsed !== 'object' || parsed === null || !('method' in parsed) || !('rpcId' in parsed)
    || typeof parsed.method !== 'string' || typeof parsed.rpcId !== 'string') {
    throw new TypeError('expected an AgentHarness RPC request body')
  }
  return { method: parsed.method, rpcId: parsed.rpcId }
}

describe.skipIf(process.platform === 'win32')('AgentHarness bridge presence lease', () => {
  it('announces at startup, heartbeats by the Host TTL, and withdraws on disposal', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = requestBody(init)
      calls.push(body.method)
      return response(body.rpcId, { presenceTtlMs: 3_000 })
    }
    const lease = new AgentHarnessBridgePresenceLease({
      ...await connectionOptions(fetchImpl), retryMs: 250, fallbackTtlMs: 15_000, minHeartbeatMs: 500, maxHeartbeatMs: 30_000,
      participantId: 'cursor-agent', displayName: 'Cursor Agent',
    })

    await lease.start()
    expect(calls).toEqual(['developmentRooms/announce'])
    await vi.advanceTimersByTimeAsync(1_000)
    await lease.start()
    expect(calls).toEqual(['developmentRooms/announce', 'developmentRooms/heartbeat'])
    await lease.dispose()
    expect(calls.at(-1)).toBe('developmentRooms/withdraw')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-announces after a heartbeat fails across a Harness restart', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    let failHeartbeat = true
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = requestBody(init)
      calls.push(body.method)
      if (body.method === 'developmentRooms/heartbeat' && failHeartbeat) {
        failHeartbeat = false
        return response(body.rpcId, undefined, false)
      }
      return response(body.rpcId, { presenceTtlMs: 1_500 })
    }
    const lease = new AgentHarnessBridgePresenceLease({
      ...await connectionOptions(fetchImpl), retryMs: 250, fallbackTtlMs: 15_000, minHeartbeatMs: 500, maxHeartbeatMs: 30_000,
      participantId: 'codex-agent', displayName: 'Codex Agent',
    })

    await lease.start()
    await vi.advanceTimersByTimeAsync(500)
    await lease.start()
    await vi.advanceTimersByTimeAsync(250)
    await lease.start()
    expect(calls).toEqual([
      'developmentRooms/announce',
      'developmentRooms/heartbeat',
      'developmentRooms/announce',
    ])
    await lease.dispose()
  })

  it('keeps the MCP process usable when Harness is unavailable at startup', async () => {
    vi.useFakeTimers()
    let available = false
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = requestBody(init)
      calls.push(body.method)
      if (!available) throw new Error('connection refused')
      return response(body.rpcId, { presenceTtlMs: 1_500 })
    }
    const lease = new AgentHarnessBridgePresenceLease({
      ...await connectionOptions(fetchImpl), retryMs: 250, fallbackTtlMs: 15_000, minHeartbeatMs: 500, maxHeartbeatMs: 30_000,
      participantId: 'late-agent', displayName: 'Late Agent',
    })

    await expect(lease.start()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    available = true
    await vi.advanceTimersByTimeAsync(250)
    await lease.start()
    expect(calls).toEqual(['developmentRooms/announce', 'developmentRooms/announce'])
    await lease.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts an unacknowledged announcement, joins repeated dispose, and still withdraws', async () => {
    const entered = Promise.withResolvers<undefined>()
    const calls: string[] = []
    const options = await connectionOptions(async (_input, init) => {
      const body = requestBody(init)
      calls.push(body.method)
      if (body.method !== 'developmentRooms/announce') return response(body.rpcId, {})
      entered.resolve(undefined)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('cancelled transport')) }, { once: true })
      })
    })
    const lease = new AgentHarnessBridgePresenceLease({
      ...options, participantId: 'pending-agent', displayName: 'Pending Agent',
      retryMs: 250, fallbackTtlMs: 15_000, minHeartbeatMs: 500, maxHeartbeatMs: 30_000,
    })
    const start = lease.start()
    await entered.promise
    const close = lease.dispose()
    expect(lease.dispose()).toBe(close)
    await Promise.all([start, close])
    await lease.start()
    expect(calls).toEqual(['developmentRooms/announce', 'developmentRooms/withdraw'])
  })

  it('cancels a stalled heartbeat, bounds stalled withdrawal, and leaves no renewal timer', async () => {
    vi.useFakeTimers()
    const heartbeat = Promise.withResolvers<undefined>()
    const withdrawing = Promise.withResolvers<undefined>()
    const calls: string[] = []
    const options = await connectionOptions(async (_input, init) => {
      const body = requestBody(init)
      calls.push(body.method)
      if (body.method === 'developmentRooms/announce') return response(body.rpcId, { presenceTtlMs: 1_500 })
      if (body.method === 'developmentRooms/heartbeat') heartbeat.resolve(undefined)
      if (body.method === 'developmentRooms/withdraw') withdrawing.resolve(undefined)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('cancelled transport')) }, { once: true })
      })
    })
    const lease = new AgentHarnessBridgePresenceLease({
      ...options, participantId: 'blocked-agent', displayName: 'Blocked Agent',
      retryMs: 250, fallbackTtlMs: 15_000, minHeartbeatMs: 500, maxHeartbeatMs: 30_000,
    })
    await lease.start()
    await vi.advanceTimersByTimeAsync(500)
    await heartbeat.promise
    const close = lease.dispose()
    await withdrawing.promise
    await vi.advanceTimersByTimeAsync(options.requestTimeoutMs)
    await close
    expect(calls).toEqual(['developmentRooms/announce', 'developmentRooms/heartbeat', 'developmentRooms/withdraw'])
    expect(vi.getTimerCount()).toBe(0)
  })

})
