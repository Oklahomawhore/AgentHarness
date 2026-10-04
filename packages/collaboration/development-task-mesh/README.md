---
description: "@deepseek-ai/dsh-development-task-mesh registers development-task/v1 on the generic Mesh"
kind: "package-reference"
---
# Development Task Mesh consumer

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-task-mesh` registers `development-task/v1` on the generic Mesh. It sends content blocks before dependent Task creation events, then Task and session-binding deltas by per-origin heads. The receive queue resolves out-of-order parent, block, revision, and binding dependencies before persistence.

Context publication, approved observations, interval queries, and terminal requests route to the Task owner. Cached remote Tasks remain readable while the owner is offline; owner requests fail with `RUNTIME_UNAVAILABLE`. Conflicting event identities produce `REPLICA_CONFLICT`, which the provider uses to isolate the peer.

## Table of Contents

- [Observed source routing](#observed-source-routing)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="observed-source-routing"></a>

## Observed source routing

The command dispatcher passes the actual Mesh peer identity to Task admission and termination. Observation JSON cannot select that identity. The owner must explicitly approve the source Agent and binding epoch; Mesh membership alone does not grant an observation interval. The [Task service](../development-task/README.md#remote-observation-authority) owns approval, original durable receipts, and terminal withdrawal semantics.

The adapter validates incoming commands and remote interval, admission, and termination results. An interval list is accepted only when every item matches the queried Task, its derived source identity, and its approval or termination receipts from the routed owner; a mismatch rejects the whole list. Malformed results cannot acknowledge a caller's pending operation. A dropped response leaves the caller responsible for retrying the same identity; the owner returns its original receipt without another event. Offline and timeout errors remain distinguishable from invalid requests and denied authority.


<a id="model-experience"></a>

## Model Experience

None, as the Task Mesh Consumer registers no prompt, tool, message, or model input.

#### KV Cache effect

None in this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Binding conflicts use origin ownership and immutable event identity, not distributed consensus.
- The dependency queue has a fixed safety bound and no disk spill.
- The Mesh shares credentials and replicates all Task data among trusted members. Observation approval does not add independent user authentication or per-Task read permissions.

No invariant companion is published because the Task service validates incoming event and binding identities; this consumer derives replication heads from those logs.

<a id="dev-note"></a>

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
