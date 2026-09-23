---
description: "@deepseek-ai/dsh-development-room-mesh registers development-room/v1 on the generic Mesh"
kind: "package-reference"
---
# Development Room Mesh consumer

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-room-mesh` registers `development-room/v1` on the generic Mesh. It replicates Room append-only events and participant presence as deltas, routes join and leave to the Room creation node, and marks a disconnected node's participants offline. Room remains a hidden runtime primitive for Task membership.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Model Experience

None, as the Room Mesh Consumer registers no prompt, tool, message, or model input.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Presence is lease state rather than durable Room history.
- The package does not expose user-facing Room tools or UI.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
