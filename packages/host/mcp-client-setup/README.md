---
description: "Trusted Host service for detecting local AI clients and registering the installed AgentHarness MCP bridge"
kind: "package-reference"
---
# @deepseek-ai/dsh-host-mcp-client-setup

English | [中文](README.zh.md)

## Summary

Trusted Host service for detecting local AI clients and registering the installed AgentHarness MCP bridge. The `mcpClientSetup/list` Remote separates installed, configured, conflicting, manual-only, unsupported, and failed states. `mcpClientSetup/setup` changes exactly one requested client.

Cursor, WorkBuddy, and CodeBuddy use documented user-level JSON files. A write is owner-only, atomic, preserves unrelated servers, and stops on invalid JSON, an unexpected `mcpServers` value, a symbolic link, or a different existing `agentharness` entry. Codex and Claude Code use their official MCP CLI after a read-only conflict check. TRAE and Doubao are detected but left unchanged when no stable public unattended registration mechanism is available.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Configuration

Five deployment fields are required. `nodePath` and `dshPath` are absolute paths to Node and the actual `dsh` CLI; `nodeArgs` holds explicit Node arguments (the source CLI uses the ESM-only `tsx` hook). `harnessHome` is the absolute home passed as `DSH_HOME` in each client entry. `descriptorPath` is the absolute private Connection descriptor, normally `<harnessHome>/mcp/connection.json`. For source launch, optional `sourceTsconfigPath` supplies an absolute workspace config as `TSX_TSCONFIG_PATH`, so client working directories do not affect module resolution; built launch omits it. Entries run `dsh --profile mcp --connection <descriptorPath>` with a per-client participant identity; they do not contain a launch token, cookie, or fixed Host port.

The service requires `connection`, `webServer`, and the dsh application lifecycle. On macOS/Linux it publishes the descriptor after application readiness, using the Host's actual port, and removes its own descriptor on disposal. The [Connection local-access helper](../../client/connection/README.md) owns file permissions, exclusive publication, and authentication. The file grants the same local user's full Connection authority; it is not a Task-specific permission. Keep its directory private.

Windows reports `unsupported`, disables setup, and publishes no descriptor. The ordinary Web application remains available. A successful client write means the launch configuration matches, including `DSH_HOME`; a different existing entry is a conflict and is never overwritten.


## Model Experience

None, as this Host service does not add model input and only configures the [MCP profile](../../mcp/agentharness-bridge/README.md) for clients the user already runs.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

No runtime invariant companion is published because listing and setup inspect client configuration directly and retain no independent configuration cache to reconcile.

- JSON-with-comments files are reported as conflicts rather than rewritten because preserving their comments safely is not yet supported.
- Client reload or restart remains client-owned. A successful write proves configuration, not that the client launched the bridge.
- The service does not edit private application databases or approval records.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
