# Agent Note: Host MCP calls use a service seam, not ToolRuntime

Status: implemented

English | [中文](2026-08-20-host-mcp-call-seam.zh.md)

## Problem

Product plugins need to retrieve enterprise evidence through existing MCP servers before an Agent starts work. The shipped MCP client exposed every remote tool only through `ctx.tools`. That interface is owned by model tool execution: it applies presentation selection, model-call approval, task-support rejection, and session-facing rendering. A trusted Host Consumer calling the same path would inherit behavior intended for model requests and could lose non-text MCP content before applying its own evidence policy. Reimplementing MCP transport in every evidence plugin would instead duplicate connection, validation, timeout, cancellation, authentication, and reconnect behavior.

## Decision

Add `@deepseek-ai/dsh-mcp` as the transport-independent Service Definition for Host-side MCP tool calls. A transport provider registers one exact connected server generation on `ctx.mcp`; a Consumer calls a raw server-owned tool name with JSON arguments and caller cancellation. The service returns complete JSON content blocks and optional structured content. It does not register model schemas, request approval, render results, or append session events.

`@deepseek-ai/dsh-mcp-client` is both the shipped Service Provider and the existing model-tool bridge. After connection and successful discovery, it publishes the same client generation to `ctx.mcp` and registers discovered definitions on `ctx.tools`. Disconnect removes the direct Host route before closing the generation. The last known model-tool definitions keep their existing outage behavior so a reconnect can replace them without prompt-schema churn. Reconnect publishes only the recovered generation.

The base bundle mounts the Service Definition, while MCP transports remain optional composition. Consumers depend on `@deepseek-ai/dsh-mcp`, not on the concrete client implementation. A Consumer owns the policy that selects, bounds, and records any returned evidence before it becomes model-visible.

## Consequences

Background indexers and evidence providers can reuse one supervised MCP transport without entering model execution. Direct calls fail loud when the configured server is disconnected, use the transport provider's timeout and authentication, and preserve JSON protocol content for Consumer validation. The registry is deliberately process-local and contains only callable generations. It exposes `tools/call`; resources, prompts, discovery metadata, MCP task-mode execution, and sampling remain deferred.

The model-visible path remains unchanged. `ctx.tools` continues to enforce task-support and produces the existing Native text projection. `ctx.mcp` does not enforce those model-specific rules, so a Host Consumer must call only tools whose ordinary `tools/call` response is appropriate for direct execution.

## Alternatives considered

- **Call `ctx.tools.execute()` from Host plugins** — couples product retrieval to model approval and presentation behavior and can discard protocol content before Consumer validation.
- **Expose the MCP SDK client from `mcp-client`** — makes Consumers depend on one transport implementation and leaks connection-generation ownership.
- **Open a separate MCP connection in each Consumer** — duplicates subprocesses, credentials, reconnect loops, and protocol validation while making lifecycle state disagree across plugins.
