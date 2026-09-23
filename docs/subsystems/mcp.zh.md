# 模型上下文协议

[English](mcp.md) | 中文

MCP 子系统把传输复用与模型工具执行分开。`@deepseek-ai/dsh-mcp` 定义进程内 `ctx.mcp` 服务；传输提供者只发布已连接世代，可信宿主消费者通过配置服务器和原始工具名调用。`@deepseek-ai/dsh-mcp-client` 提供默认 stdio 和 Streamable HTTP 实现，同时独立地把已发现工具投影到 `ctx.tools` 供模型使用。

宿主直接调用保留 JSON 协议内容，使用调用方取消信号和提供者超时，并在对应传输世代断开时立即消失。它不会请求模型工具审批、渲染模型结果或写入 Session 历史。消费者如要把返回数据送入模型请求，必须先执行自身的选择、大小、访问和日志规则。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
