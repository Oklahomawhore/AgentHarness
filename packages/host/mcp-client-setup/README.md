---
description: "Trusted Host service for detecting local AI clients and registering the installed AgentHarness MCP bridge"
kind: "package-reference"
---
# @deepseek-ai/dsh-host-mcp-client-setup

English | [中文](README.zh.md)

## Summary

Trusted Host service for detecting local AI clients and registering the installed AgentHarness MCP bridge. The `mcpClientSetup/list` Remote separates installed, configured, conflicting, manual-only, and failed states. `mcpClientSetup/setup` changes exactly one requested client.

Cursor, WorkBuddy, and CodeBuddy use documented user-level JSON files. A write is owner-only, atomic, preserves unrelated servers, and stops on invalid JSON, an unexpected `mcpServers` value, a symbolic link, or a different existing `agentharness` entry. Codex and Claude Code use their official MCP CLI after a read-only conflict check. TRAE and Doubao are detected but left unchanged when no stable public unattended registration mechanism is available.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Model Experience

None, as this Host service does not add model input and only makes the separately packaged AgentHarness bridge available to clients the user already runs.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- JSON-with-comments files are reported as conflicts rather than rewritten because preserving their comments safely is not yet supported.
- Client reload or restart remains client-owned. A successful write proves configuration, not that the client launched the bridge.
- The service does not edit private application databases or approval records.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
