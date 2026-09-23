# Model Context Protocol

English | [中文](mcp.zh.md)

The MCP subsystem separates transport reuse from model tool execution. `@deepseek-ai/dsh-mcp` defines the process-local `ctx.mcp` service; transport providers publish only connected generations, and trusted Host Consumers address a configured server plus its raw tool name. `@deepseek-ai/dsh-mcp-client` supplies the default stdio and Streamable HTTP provider while independently projecting discovered tools onto `ctx.tools` for models.

Direct Host calls retain JSON protocol content, use caller cancellation and provider timeouts, and disappear as soon as their transport generation disconnects. They do not request model-tool approval, render model results, or write Session history. A Consumer that admits returned data into a model request must first apply its own selection, size, access, and logging rules.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcp--mcpservice"></a>

### `ctx.mcp` — `McpService`

Service Definition for transport-independent, Host-side MCP tool calls.

```ts cordis-catalog
/**
 * Register one connected transport provider for its exact live generation.
 * @param provider - server identity and raw call implementation.
 * @returns disposer that removes only this registration.
 */
registerServer(provider: McpServerProvider): () => void

/**
 * List currently callable servers in deterministic order.
 * @returns detached identities sorted by server id.
 */
listServers(): readonly McpServerRegistration[]

/**
 * Call one raw MCP tool without entering the model-facing ToolRuntime pipeline.
 * @param request - exact server, raw tool name, and JSON arguments.
 * @param signal - required caller cancellation.
 * @returns complete protocol result from the registered transport provider.
 */
call(request: McpCallRequest, signal: AbortSignal): Promise<McpCallResult>
```

Source: [`packages/mcp/mcp/src/index.ts`](../../packages/mcp/mcp/src/index.ts)

<a id="ctxmcpclientsetup--mcpclientsetupservice"></a>

### `ctx.mcpClientSetup` — `McpClientSetupService`

Trusted Host Remote for detection and explicit browser-initiated setup.

```ts cordis-catalog
/**
 * Return the current configuration state of every recognized client.
 *
 * @returns One point-in-time client detection and configuration snapshot.
 */
@Remote('list') list(): Promise<McpClientSetupSnapshot>

/**
 * Configure exactly one supported client after conflict-safe inspection.
 *
 * @param request - Client id and optional display-name override.
 * @returns The exact setup outcome plus the refreshed client state.
 */
@Remote('setup') setup(request: McpClientSetupRequest): Promise<McpClientSetupResult>
```

Source: [`packages/host/mcp-client-setup/src/index.ts`](../../packages/host/mcp-client-setup/src/index.ts)

<a id="mcp-events"></a>

### `mcp/*` events

<a id="mcpserver-changed--emit"></a>

#### `mcp/server-changed` — emit

A callable MCP server was registered or removed.

```ts cordis-catalog
/**
 * A callable MCP server was registered or removed.
 * @param server - detached server identity.
 * @param state - resulting registry state.
 * @mode emit
 */
'mcp/server-changed'(server: McpServerRegistration, state: 'registered' | 'unregistered'): void
```

Source: [`packages/mcp/mcp/src/index.ts`](../../packages/mcp/mcp/src/index.ts)
<!-- END GENERATED cordis-surface -->
