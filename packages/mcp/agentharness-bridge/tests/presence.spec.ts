import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHarnessBridgePresenceLease } from '../src/index.ts'

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

describe('AgentHarness bridge presence lease', () => {
  it('announces at startup, heartbeats by the Host TTL, and withdraws on disposal', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = requestBody(init)
      calls.push(body.method)
      return response(body.rpcId, { presenceTtlMs: 3_000 })
    }
    const lease = new AgentHarnessBridgePresenceLease({
      url: 'http://127.0.0.1:3080', participantId: 'cursor-agent', displayName: 'Cursor Agent', fetch: fetchImpl,
    })

    await lease.start()
    expect(calls).toEqual(['developmentRooms/announce'])
    await vi.advanceTimersByTimeAsync(1_000)
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
      url: 'http://127.0.0.1:3080', participantId: 'codex-agent', displayName: 'Codex Agent', fetch: fetchImpl, retryMs: 250,
    })

    await lease.start()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toEqual([
      'developmentRooms/announce',
      'developmentRooms/heartbeat',
      'developmentRooms/announce',
    ])
    await lease.dispose()
  })

  it('keeps the MCP process usable when Harness is unavailable at startup', async () => {
    vi.useFakeTimers()
    const fetchImpl: typeof fetch = async () => { throw new Error('connection refused') }
    const lease = new AgentHarnessBridgePresenceLease({
      url: 'http://127.0.0.1:3080', participantId: 'late-agent', displayName: 'Late Agent', fetch: fetchImpl, retryMs: 250,
    })

    await expect(lease.start()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    await lease.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
