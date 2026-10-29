---
description: "@deepseek-ai/dsh-development-mesh-websocket provides authenticated incremental replication over WebSocket"
kind: "package-reference"
---
# Development Mesh WebSocket provider

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-mesh-websocket` provides authenticated incremental replication over WebSocket. Startup resolves `secretRef`; the secret must contain at least 32 bytes. Discovery announcements, upgrade handshakes, and every envelope use HMAC-SHA256. Nonces, a bounded clock window, and increasing per-connection sequence numbers reject replay. The status API returns only cluster id and secret fingerprint.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

Configured peers and authenticated IPv4 multicast discovery can coexist. The lower node id owns dialing, reconnect uses bounded backoff, and channel heads resume missing deltas after reconnect. A reused event identity with different content isolates and disconnects the peer; channels still receive its offline notification. An isolated peer cannot open another incoming connection. Frames arriving on a closing socket cannot dispatch new commands. Commands time out independently of replication.

The upgrade path must already be a canonical URL pathname; percent-encoded paths remain supported. Peer URLs use `ws:` or `wss:` without fragments. Construction rejects a configured peer when its complete signed initial hello exceeds `maxMessageBytes`. The transport applies the same check before retaining or dialing a discovered peer; rejection reports a warning and leaves discovery active.

Discovery requires successful socket binding and multicast membership. Datagram send failures are reported as warnings while the listener and its configured announcement interval stay active, including after the first send. Successful local startup does not establish peer discovery or delivery. Invalid announcement byte limits still reject startup. Startup failure releases configured peer sockets and reconnect timers acquired before discovery becomes ready.

Replication sends the complete delta in ordered frames bounded by both `maxEventsPerFrame` and signed-envelope `maxMessageBytes`. One event that cannot fit fails the peer operation without truncation. Each connection processes event frames in order while commands and results remain independent. Work retained across an asynchronous read or handler cannot send on a replacement socket; background failures are reported through the owning peer.

Frames rejected during serialization or the byte-limit check do not consume a connection sequence. A rejected frame does not make subsequent bounded traffic fail sequence validation. An oversized result can still return an error when that error fits the byte limit.

Authentication provides node identity and message integrity, not encryption. LAN HTTP release downloads and Mesh payloads remain observable to a passive network listener.

## Model Experience

None, as the authenticated Mesh transport registers no prompt, tool, message, or model input.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Discovery is limited to one IPv4 multicast domain; routed networks require explicit peers.
- Key rotation requires an explicit coordinated maintenance window.
- TLS and individual participant authentication are not provided.

No invariant companion is published because frame authentication and sequence validation run before dispatch, while peer snapshots read the provider's connection records.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
