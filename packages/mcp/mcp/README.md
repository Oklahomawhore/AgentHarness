---
description: "Transport-independent Service Definition for raw MCP tool calls from trusted Host Consumers"
kind: "package-reference"
---
# @deepseek-ai/dsh-mcp

English | [中文](README.zh.md)

## Summary

Transport-independent Service Definition for raw MCP tool calls from trusted Host Consumers. Providers register one connected server generation on `ctx.mcp`; Consumers address the configured server id and the server's raw tool name without entering the model-facing ToolRuntime pipeline.

This seam is intentionally separate from model tool execution. A background indexer, evidence adapter, or other Host Consumer does not inherit Code Mode presentation collapse, human approval intended for model calls, prompt schemas, or Session tool history. The transport provider still owns network validation, call timeout, cancellation, authentication, and protocol errors.

## Table of Contents

- [Configuration](#configuration)
- [Extension points](#extension-points)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Configuration

`maxServers` is the maximum number of live transport registrations in one Host process. It is required and validated at load. Server ids match `[A-Za-z0-9_-]{1,32}`; duplicate and over-limit registrations fail loud.

## Extension points

- `ctx.mcp.registerServer(provider)` registers one live generation and returns its disposer.
- `ctx.mcp.listServers()` returns deterministic detached identities.
- `ctx.mcp.call(request, signal)` routes one raw `tools/call` request to the exact live provider.
- `mcp/server-changed` reports provider lifecycle for diagnostics and invariants.

`@deepseek-ai/dsh-mcp-client` is the shipped Service Provider. An external Consumer depends on this package, not on that concrete transport.

## Model Experience

### Host calls

#### What the model sees

Nothing. `ctx.mcp.call()` does not register a schema, append a Session event, or enter the ToolRuntime pipeline. A Consumer must use its own reviewed path before any returned content becomes model-visible.

#### Token effect

Zero tokens until a separate Consumer explicitly admits derived content.

#### KV Cache effect

None. Host MCP calls do not create model requests.

## Known Limitations and Deferred Work

- The seam covers MCP `tools/call` only. Resources, prompts, task-mode execution, discovery metadata, and sampling remain outside this interface.
- The registry is process-local and represents only currently connected generations. A disconnect removes the server until its provider reconnects.
- Provider authentication and per-tool authorization remain transport responsibilities; this service neither stores credentials nor broadens access.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
