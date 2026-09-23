/** Minimal loopback-only Typert RPC client used by the AgentHarness MCP bridge. */

import { randomUUID } from 'node:crypto'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Loopback Harness API transport; remote hosts are rejected until authenticated transport ships. */
export class AgentHarnessRpcClient {
  /** Normalized loopback origin used for every generated API request. */
  readonly origin: string

  constructor(url: string, private readonly fetchImpl: typeof fetch = globalThis.fetch) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('agentharness bridge: Harness URL must use http or https')
    }
    if (!isLoopback(parsed.hostname)) {
      throw new TypeError('agentharness bridge: only loopback Harness URLs are allowed in this release')
    }
    parsed.pathname = '/'
    parsed.search = ''
    parsed.hash = ''
    this.origin = parsed.origin
  }

  /**
   * Invoke one generated Remote endpoint with named wire arguments.
   * @param endpoint - generated `service/method` API name.
   * @param args - named Typert wire arguments.
   * @returns the decoded successful Remote value.
   */
  async call<Result>(endpoint: string, args: Record<string, unknown>): Promise<Result> {
    if (!/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/.test(endpoint)) {
      throw new TypeError(`agentharness bridge: invalid endpoint ${JSON.stringify(endpoint)}`)
    }
    const rpcId = randomUUID()
    const response = await this.fetchImpl(new URL(`/api/${endpoint}`, this.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args },
      }),
    })
    if (!response.ok) throw new Error(`agentharness bridge: ${endpoint} transport failed with HTTP ${String(response.status)}`)
    const body: unknown = await response.json()
    if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isRecord(body.result)
      || typeof body.result.ok !== 'boolean') {
      throw new Error(`agentharness bridge: ${endpoint} returned an invalid response envelope`)
    }
    if (!body.result.ok) {
      const error = body.result.error
      if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new Error(`agentharness bridge: ${endpoint} returned an invalid error envelope`)
      }
      throw new Error(`agentharness bridge: ${error.code}: ${error.message}`)
    }
    return body.result.value as Result
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
}
