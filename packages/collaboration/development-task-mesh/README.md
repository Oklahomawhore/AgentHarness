---
description: "@deepseek-ai/dsh-development-task-mesh registers development-task/v1 on the generic Mesh"
kind: "package-reference"
---
# Development Task Mesh consumer

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-task-mesh` registers `development-task/v1` on the generic Mesh. It sends content blocks before dependent Task creation events, then Task and session-binding deltas by per-origin heads. The receive queue resolves out-of-order parent, block, revision, and binding dependencies before persistence.

Explicit context publication routes to the Task owner node. Cached remote Tasks remain readable while the owner is offline, while publication fails with `RUNTIME_UNAVAILABLE`. A committed or queued event identity carrying different content produces `REPLICA_CONFLICT`, which the provider uses to isolate the peer.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Model Experience

None, as the Task Mesh Consumer registers no prompt, tool, message, or model input.

#### KV Cache effect

None in this package.

## Known Limitations and Deferred Work

- Binding conflicts use origin ownership and immutable event identity, not distributed consensus.
- The dependency queue has a fixed safety bound and no disk spill.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
