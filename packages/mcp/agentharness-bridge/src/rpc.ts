/** Authenticated, bounded loopback RPC requests for one MCP bridge lifecycle. */

import { randomUUID } from 'node:crypto'
import { authenticateLocalConnection, LocalConnectionAccessError } from '@deepseek-ai/dsh-client-connection/local-access'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Explicit connection and complete request limits for the bridge library. */
export interface AgentHarnessRpcOptions {
  /** Absolute private connection descriptor path. */
  readonly connectionPath: string
  /** Optional origin pin; it never bypasses descriptor authentication. */
  readonly url?: string
  /** Deadline spanning descriptor authentication, RPC, and response body. */
  readonly requestTimeoutMs: number
  /** Maximum complete descriptor bytes. */
  readonly maxDescriptorBytes: number
  /** Maximum complete outgoing RPC JSON bytes. */
  readonly maxRequestBytes: number
  /** Maximum complete incoming RPC JSON bytes. */
  readonly maxResponseBytes: number
  /** Lifecycle cancellation shared by ordinary requests. */
  readonly signal?: AbortSignal
  /** Fetch implementation, including authentication; defaults to the platform fetch. */
  readonly fetch?: typeof fetch
}

/** Safe failures contain no remote error text, URL tokens, or authentication cookies. */
export class AgentHarnessRpcError extends Error {
  /**
   * Construct a diagnostic without remote text or credentials.
   * @param code - controlled failure category.
   */
  constructor(readonly code: string) {
    super(`agentharness bridge: ${code}`)
    this.name = 'AgentHarnessRpcError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse an optional explicit loopback origin pin without retaining URL credentials.
 * @param value - user-supplied http(s) origin.
 * @returns the normalized origin.
 */
export function bridgeOrigin(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new AgentHarnessRpcError('invalid-origin') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AgentHarnessRpcError('invalid-origin')
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new AgentHarnessRpcError('invalid-origin')
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]' && !/^127(?:\.[0-9]{1,3}){3}$/.test(parsed.hostname)) {
    throw new AgentHarnessRpcError('non-loopback-origin')
  }
  if (parsed.pathname !== '/') throw new AgentHarnessRpcError('invalid-origin')
  return parsed.origin
}

/** Authenticates each request against the current local descriptor generation. */
export class AgentHarnessRpcClient {
  private readonly expectedOrigin: string | undefined
  private readonly lifetime = new AbortController()
  private readonly requests = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  constructor(private readonly options: AgentHarnessRpcOptions) {
    this.expectedOrigin = options.url === undefined ? undefined : bridgeOrigin(options.url)
  }

  /**
   * Invoke one generated Remote endpoint; cancellation and the deadline cover its entire body.
   * @param endpoint - generated service/method API name.
   * @param args - named Typert wire arguments.
   * @param signal - operation cancellation, in addition to the client lifecycle.
   * @returns the decoded successful Remote value; failures contain only a safe code.
   */
  call<Result>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pending = this.request<Result>(endpoint, args, signal).finally(() => { this.requests.delete(pending) })
    this.requests.add(pending)
    return pending
  }

  /** Abort owned requests and wait until all requests have settled. */
  dispose(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.requests)
    })()
    return this.closing
  }

  private async request<Result>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    if (!/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/.test(endpoint)) throw new AgentHarnessRpcError('invalid-endpoint')
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
    if (Buffer.byteLength(body) > this.options.maxRequestBytes) throw new AgentHarnessRpcError('request-too-large')
    const signals = [this.lifetime.signal, this.options.signal, signal].filter(item => item !== undefined)
    using timer = deadline(AbortSignal.any(signals), this.options.requestTimeoutMs, 'bridge-request-timeout')
    try {
      timer.signal.throwIfAborted()
      const access = await authenticateLocalConnection({
        descriptorPath: this.options.connectionPath, maxDescriptorBytes: this.options.maxDescriptorBytes,
      }, timer.signal, this.options.fetch)
      timer.signal.throwIfAborted()
      if (this.expectedOrigin !== undefined && access.origin !== this.expectedOrigin) {
        throw new AgentHarnessRpcError('origin-mismatch')
      }
      const response = await (this.options.fetch ?? globalThis.fetch)(new URL(`/api/${endpoint}`, access.origin), {
        method: 'POST', redirect: 'manual', signal: timer.signal,
        headers: { 'content-type': 'application/json', cookie: access.cookie }, body,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new AgentHarnessRpcError(`http-${String(response.status)}`)
      }
      const value = await readResponse(response, this.options.maxResponseBytes, timer.signal)
      timer.signal.throwIfAborted()
      if (!isRecord(value) || value.type !== 'server-response' || value.rpcId !== rpcId || !isRecord(value.result)
        || typeof value.result.ok !== 'boolean') throw new AgentHarnessRpcError('invalid-response')
      if (!value.result.ok) throw new AgentHarnessRpcError('remote-rejected')
      return value.result.value as Result
    } catch (error) {
      if (timer.signal.aborted) {
        throw new AgentHarnessRpcError(timeoutOf(timer.signal, 'bridge-request-timeout') === undefined ? 'cancelled' : 'request-timeout')
      }
      if (error instanceof AgentHarnessRpcError) throw error
      if (error instanceof LocalConnectionAccessError) throw new AgentHarnessRpcError(error.code)
      throw new AgentHarnessRpcError('transport-failed')
    }
  }
}

async function readResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new AgentHarnessRpcError('invalid-response')
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => {
      // Fetch body cancellation can reject after transport failure; the read reports that failure.
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new AgentHarnessRpcError('response-too-large')
      chunks.push(result.value)
    }
    signal.throwIfAborted()
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown } catch {
      throw new AgentHarnessRpcError('invalid-response')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}
