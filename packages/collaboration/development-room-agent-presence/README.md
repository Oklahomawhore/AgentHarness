---
description: "Host Consumer that projects live Harness Agents into developmentRooms participant leases"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room-agent-presence

English | [中文](README.zh.md)

## Summary

Host Consumer that projects live Harness Agents into `developmentRooms` participant leases. It derives an opaque stable participant id and short display name from each Agent Session id, renews the lease, and withdraws it when the Agent is disposed or the plugin unloads.

`heartbeatMs` controls renewal cadence and must remain below the development-room presence TTL in the assembled deployment.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Model Experience

### Request context and condition

#### What the model sees

Nothing. The package observes `Agent` lifecycle state and contributes collaboration presence; it adds no prompt, tool, message, or model input.

#### Token effect

Zero tokens.

#### KV Cache effect

No cache keys or prefixes change because this package does not modify model requests.

## Known Limitations and Deferred Work

- Agent display names expose only a short Session-id prefix.
- Remote presence is reacquired after mesh reconnect or process restart.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
