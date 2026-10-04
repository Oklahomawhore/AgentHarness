/** Authentication, complete-message budgets, and cancellation of the actual RPC consumer. */

import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHarnessRpcClient } from '../src/rpc.ts'
import { connectionOptions } from './connection.ts'

afterEach(() => { vi.useRealTimers() })

function envelope(init: RequestInit | undefined, value: unknown): string {
  if (typeof init?.body !== 'string') throw new Error('expected RPC JSON')
  const request = JSON.parse(init.body) as { rpcId: string }
  return JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
}

function blocked(signal: AbortSignal | null | undefined): Promise<Response> {
  if (signal == null) throw new Error('expected request cancellation')
  return new Promise((_resolve, reject) => {
    signal.throwIfAborted()
    signal.addEventListener('abort', () => { reject(new Error('transport aborted')) }, { once: true })
  })
}

describe.skipIf(process.platform === 'win32')('bridge authenticated RPC', () => {
  it('authenticates every request and rejects an origin pin without calling the API', async () => {
    const api = vi.fn<typeof fetch>(async (_input, init) => new Response(envelope(init, 'ok')))
    const options = await connectionOptions(api)
    const rpc = new AgentHarnessRpcClient(options)
    expect(await rpc.call('tasks/get', {})).toBe('ok')
    await writeFile(options.connectionPath, JSON.stringify({
      version: 1, generation: 'replacement', launchUrl: 'http://127.0.0.1:3081/?token=replacement-secret',
    }))
    const pinned = new AgentHarnessRpcClient({ ...options, url: 'http://127.0.0.1:3080' })
    await expect(pinned.call('tasks/get', {})).rejects.toMatchObject({ code: 'origin-mismatch' })
    expect(api).toHaveBeenCalledTimes(1)
    expect(await rpc.call('tasks/get', {})).toBe('ok')
    const target = api.mock.calls[1]?.[0]
    if (!(target instanceof URL)) throw new Error('expected a normalized API URL')
    expect(target.href).toBe('http://127.0.0.1:3081/api/tasks/get')
    await Promise.all([rpc.dispose(), pinned.dispose()])
  })

  it('counts the complete multibyte response and outgoing RPC wrapper', async () => {
    let bytes = 0
    const api = vi.fn<typeof fetch>(async (_input, init) => {
      const body = envelope(init, '中文🙂')
      bytes = Buffer.byteLength(body)
      return new Response(body)
    })
    const options = await connectionOptions(api)
    await expect(new AgentHarnessRpcClient(options).call('tasks/get', {})).resolves.toBe('中文🙂')
    await expect(new AgentHarnessRpcClient({ ...options, maxResponseBytes: bytes }).call('tasks/get', {})).resolves.toBe('中文🙂')
    await expect(new AgentHarnessRpcClient({ ...options, maxResponseBytes: bytes - 1 }).call('tasks/get', {}))
      .rejects.toMatchObject({ code: 'response-too-large' })
    const calls = api.mock.calls.length
    await expect(new AgentHarnessRpcClient({ ...options, maxRequestBytes: 1 }).call('tasks/get', {}))
      .rejects.toMatchObject({ code: 'request-too-large' })
    expect(api).toHaveBeenCalledTimes(calls)
  })

  it('cancels a pending RPC and joins it on repeated disposal', async () => {
    const entered = Promise.withResolvers<undefined>()
    const options = await connectionOptions(async (_input, init) => {
      entered.resolve(undefined)
      return await blocked(init?.signal)
    })
    const rpc = new AgentHarnessRpcClient(options)
    const request = expect(rpc.call('tasks/get', {})).rejects.toMatchObject({ code: 'cancelled' })
    await entered.promise
    const close = rpc.dispose()
    expect(rpc.dispose()).toBe(close)
    await Promise.all([request, close])
  })

  it('uses one deadline for authentication and RPC and clears it after timeout', async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<undefined>()
    const options = await connectionOptions(async () => { throw new Error('API must not run') })
    const rpc = new AgentHarnessRpcClient({ ...options, fetch: async (_input, init) => {
      entered.resolve(undefined)
      return await blocked(init?.signal)
    } })
    const request = expect(rpc.call('tasks/get', {})).rejects.toMatchObject({ code: 'request-timeout' })
    await entered.promise
    await vi.advanceTimersByTimeAsync(options.requestTimeoutMs)
    await request
    await rpc.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a stalled response body within the same deadline', async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<undefined>()
    const cancel = vi.fn()
    const options = await connectionOptions(async () => {
      entered.resolve(undefined)
      return new Response(new ReadableStream<Uint8Array>({ cancel }))
    })
    const rpc = new AgentHarnessRpcClient(options)
    const request = expect(rpc.call('tasks/get', {})).rejects.toMatchObject({ code: 'request-timeout' })
    await entered.promise
    await vi.advanceTimersByTimeAsync(options.requestTimeoutMs)
    await request
    expect(cancel).toHaveBeenCalledOnce()
    await rpc.dispose()
  })

  it.each(['network', 'remote'])('does not expose secrets from %s failures', async (failure) => {
    const options = await connectionOptions(async (_input, init) => {
      if (failure === 'network') throw new Error('https://secret-host/?token=never-show-cookie')
      const parsed = JSON.parse(envelope(init, {})) as { result: unknown }
      parsed.result = { ok: false, error: { code: 'remote-secret', message: 'never-show-cookie' } }
      return new Response(JSON.stringify(parsed))
    })
    const rpc = new AgentHarnessRpcClient(options)
    await expect(rpc.call('tasks/get', {})).rejects.toMatchObject({
      message: `agentharness bridge: ${failure === 'network' ? 'transport-failed' : 'remote-rejected'}`,
    })
    await rpc.dispose()
  })

  it('rejects a pre-cancelled caller before authentication', async () => {
    const api = vi.fn<typeof fetch>()
    const options = await connectionOptions(api)
    const control = new AbortController()
    control.abort(new Error('private reason'))
    await expect(new AgentHarnessRpcClient(options).call('tasks/get', {}, control.signal))
      .rejects.toMatchObject({ message: 'agentharness bridge: cancelled' })
    expect(api).not.toHaveBeenCalled()
  })
})
