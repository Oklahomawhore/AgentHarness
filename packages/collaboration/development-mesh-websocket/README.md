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

Configured peers and authenticated IPv4 multicast discovery can coexist. The lower node id owns dialing, reconnect uses bounded backoff, and channel heads resume missing deltas after reconnect. A reused event identity with different content marks the peer conflicted and stops accepting its data. Commands time out independently of replication.

Authentication provides node identity and message integrity, not encryption. LAN HTTP release downloads and Mesh payloads remain observable to a passive network listener.

## Model Experience

None, as the authenticated Mesh transport registers no prompt, tool, message, or model input.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Discovery is limited to one IPv4 multicast domain; routed networks require explicit peers.
- Key rotation requires an explicit coordinated maintenance window.
- TLS and individual participant authentication are not provided.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
