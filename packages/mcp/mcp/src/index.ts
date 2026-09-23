/** Host-side Model Context Protocol server registry and direct tool-call seam. */

import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque configured identity of one live MCP server. */
export type McpServerId = Branded<'McpServerId'>

/** One raw MCP tool invocation addressed to a configured server. */
export interface McpCallRequest {
  readonly serverId: McpServerId
  readonly toolName: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

/** Lossless JSON result returned by one MCP tools/call request. */
export interface McpCallResult {
  readonly content: readonly JsonValue[]
  readonly structuredContent?: JsonValue
}

/** Live server provider registered by one transport implementation. */
export interface McpServerProvider {
  readonly id: McpServerId
  /**
   * Invoke one raw tool name on this server.
   * @param request - tool name and lossless JSON arguments.
   * @param signal - caller-owned cancellation.
   * @returns complete protocol content without model projection.
   */
  call(request: Omit<McpCallRequest, 'serverId'>, signal: AbortSignal): Promise<McpCallResult>
}

/** Detached identity of one currently callable MCP server. */
export interface McpServerRegistration {
  readonly id: McpServerId
}

/** Bound on live MCP transport registrations. */
export interface Config {
  /** Maximum MCP servers registered in this Host process. */
  readonly maxServers: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Transport-independent MCP server registry for trusted Host Consumers. */
    mcp: McpService
  }

  interface Events {
    /**
     * A callable MCP server was registered or removed.
     * @param server - detached server identity.
     * @param state - resulting registry state.
     * @mode emit
     */
    'mcp/server-changed'(server: McpServerRegistration, state: 'registered' | 'unregistered'): void
  }
}

/** Stable MCP registry or request validation failure. */
export class McpError extends Error {
  /** @param code - caller-routable failure classification. */
  constructor(message: string, readonly code:
    | 'DUPLICATE_SERVER'
    | 'SERVER_NOT_FOUND'
    | 'INVALID_REQUEST'
    | 'LIMIT_EXCEEDED') {
    super(message)
    this.name = 'McpError'
  }
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,32}$/

/** Service Definition for transport-independent, Host-side MCP tool calls. */
export class McpService extends Service {
  static Config: s<Config> = s.object({
    maxServers: s.number().step(1).min(1).required(),
  })

  private readonly providers = new Map<McpServerId, McpServerProvider>()
  private readonly maxServers: number

  /** Validate the process-wide server bound. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcp')
    if (!Number.isSafeInteger(config.maxServers) || config.maxServers < 1) {
      throw new TypeError('mcp: maxServers must be a positive safe integer')
    }
    this.maxServers = config.maxServers
  }

  /**
   * Register one connected transport provider for its exact live generation.
   * @param provider - server identity and raw call implementation.
   * @returns disposer that removes only this registration.
   */
  registerServer(provider: McpServerProvider): () => void {
    if (!SERVER_ID.test(provider.id)) {
      throw new McpError('MCP server id must match [A-Za-z0-9_-]{1,32}', 'INVALID_REQUEST')
    }
    if (this.providers.has(provider.id)) {
      throw new McpError(`MCP server "${provider.id}" is already registered`, 'DUPLICATE_SERVER')
    }
    if (this.providers.size >= this.maxServers) {
      throw new McpError('MCP server limit reached', 'LIMIT_EXCEEDED')
    }
    const normalized: McpServerProvider = Object.freeze({
      id: provider.id,
      call: provider.call.bind(provider),
    })
    const registration = Object.freeze({ id: provider.id })
    const dispose = this.ctx.effect(function* (this: McpService) {
      this.providers.set(provider.id, normalized)
      this.ctx.emit('mcp/server-changed', registration, 'registered')
      yield () => {
        this.providers.delete(provider.id)
        this.ctx.emit('mcp/server-changed', registration, 'unregistered')
      }
    }.bind(this), 'mcp.registerServer()')
    return () => { void dispose() }
  }

  /**
   * List currently callable servers in deterministic order.
   * @returns detached identities sorted by server id.
   */
  listServers(): readonly McpServerRegistration[] {
    return Object.freeze([...this.providers.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map(id => Object.freeze({ id })))
  }

  /**
   * Call one raw MCP tool without entering the model-facing ToolRuntime pipeline.
   * @param request - exact server, raw tool name, and JSON arguments.
   * @param signal - required caller cancellation.
   * @returns complete protocol result from the registered transport provider.
   */
  call(request: McpCallRequest, signal: AbortSignal): Promise<McpCallResult> {
    const provider = this.providers.get(request.serverId)
    if (provider === undefined) {
      throw new McpError(`MCP server "${request.serverId}" is not connected`, 'SERVER_NOT_FOUND')
    }
    const toolName = request.toolName.trim()
    if (toolName.length === 0) throw new McpError('MCP tool name must not be blank', 'INVALID_REQUEST')
    return provider.call(Object.freeze({ toolName, arguments: request.arguments }), signal)
  }
}

export default McpService
