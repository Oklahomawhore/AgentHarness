---
description: "Authenticated direct request streams with persistent device identity, complete JSON budgets, and consumer-owned scope authorization"
kind: "package-reference"
---
# Scope transport

English | [中文](README.zh.md)

## Summary

Exchange bounded JSON requests with an explicitly addressed device while retaining its identity across restarts. Noise verifies the peer's key, and each request has byte, concurrency, and time limits. [Scope access](../scope-access/README.md) authorizes each request; authenticating a connection alone grants no application read or write permission.

## Table of Contents

- [Use this package](#use-this-package)
- [Identity and requests](#identity-and-requests)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider when both devices have explicit, directly reachable TCP addresses and the consumer owns application authorization.

### Minimal configuration

Mount a [credentials provider](../../credentials/credentials/README.md), then the transport provider and its consumer. All fields below are required; values shown are a composition example rather than defaults.

```yaml
- name: '@deepseek-ai/dsh-scope-transport/libp2p'
  config:
    listenAddresses: ['/ip4/127.0.0.1/tcp/0']
    maxRequestBytes: 65536
    maxResponseBytes: 65536
    maxInboundRequests: 8
    maxOutboundRequests: 8
    maxConnections: 8
    requestTimeoutMs: 10000
    connectionTimeoutMs: 5000
```

| Field | Default | Meaning |
|---|---|---|
| `listenAddresses` | Required | Explicit IPv4/IPv6 TCP listeners; zero requests an OS-assigned port. |
| `maxRequestBytes` | Required | Complete request envelope byte budget. |
| `maxResponseBytes` | Required | Complete response envelope byte budget. |
| `maxInboundRequests` | Required | Provider-wide admitted inbound request limit. |
| `maxOutboundRequests` | Required | Provider-wide concurrent outbound request limit. |
| `maxConnections` | Required | Library connection-pruning threshold and pending inbound limit. |
| `requestTimeoutMs` | Required | Complete request or admitted handler deadline. |
| `connectionTimeoutMs` | Required | Connection, negotiation, and library shutdown deadline. |

The [configuration catalog](../../../docs/config-catalog.md) derives accepted fields from the provider schema.

Listeners accept only explicit IPv4/IPv6 TCP multiaddrs. Port zero lets the OS allocate a port. `identity()` waits for initialization and returns the public PeerId and bound addresses with their `/p2p/<PeerId>` suffix. A request target must include exactly the expected PeerId in that suffix; Noise verifies the destination's possession of the corresponding key.

`@deepseek-ai/dsh-scope-transport/address` exposes the same direct-address validation to consumers that persist recovery routes. A destination must retain the expected PeerId and use an explicit IP/TCP address with a nonzero port. Validation checks address syntax and identity selection, not network reachability.

`limits()` returns the local provider's immutable inbound and outbound request limits and request deadline. Consumers use these deployment values to leave capacity for ordinary requests when admitting long waits. These values neither advertise a remote peer's limits nor reserve slots against other consumers.

The byte limits include the complete UTF-8 JSON envelope. They must accommodate the minimum request or fixed failure response. Concurrent requests are bounded across all protocols and peers; `maxConnections` configures the library's connection-pruning threshold and pending inbound connection limit. `requestTimeoutMs` covers a complete outbound operation or admitted inbound handler. `connectionTimeoutMs` bounds connection establishment, protocol negotiation, and library connection shutdown. Both durations must fit Node's timer range.

<a id="persistent-listener-settings"></a>

### Persistent listener settings

Use `@deepseek-ai/dsh-scope-transport/libp2p-settings` in place of `/libp2p` when users configure listeners through a [settings provider](../../settings/settings/README.md). It requires both settings and credentials, accepts the same Config, and registers `scope-network` with `{ listenAddresses: string[] }`. The composed listeners form the base; durable user values override them. Settings reports `applies: restart`: saving changes neither the running sockets nor PeerId. The next provider startup samples the resolved listeners once, with no live watcher. Unloading removes the settings registration and drains the inherited transport.

Both base values and user writes must contain valid, distinct direct TCP listeners. IPv4 loopback (`127.0.0.0/8`) and IPv6 loopback (`::1`) may use port zero; every other listener requires a fixed nonzero port. `/libp2p` retains port-zero support for any valid listener. Invalid saved settings reject startup without replacement or fallback. A valid saved port can still be occupied or unavailable at startup; correct the settings document or release the conflicting listener before restarting.

Listener changes preserve the credential-backed PeerId. They do not update copied invitations, grant application permissions, open a firewall, or prove reachability from another device. Share an address returned by `identity()` after successful startup, including its actual port and peer suffix; wildcard listeners can advertise several interfaces.

<a id="identity-and-requests"></a>
## Identity and requests

The provider atomically creates or reads `credentialKey('scope-transport', 'identity')` through `credentials.modifyRecord`. Its grant payload contains version 1 and the canonical base64 encoding of a libp2p Ed25519 private key. Existing malformed records fail startup without replacement. Concurrent starts use the committed record returned by the credentials provider. Public state exposes only the PeerId and addresses; errors never include stored key material.

An active instance keeps its initial identity. Changing or deleting the credential logs that restart is required; it does not rotate the live key. Restart after deletion creates a new identity. Consumers must bind their durable grants and subscriptions to the public identity rather than interpreting a new key as the previous device.

`register(protocol, handler)` installs one versioned protocol and returns an idempotent disposer, which the consumer owns with `ctx.effect`. The handler receives the sender authenticated by Noise, an untrusted JSON payload, and an abort signal. It must authorize every request using that authenticated sender, settle when cancelled, and return a lossless JSON value. Registration disposal prevents new admissions and cancels its admitted work. Provider disposal cancels all work, stops listeners and connections, and waits for owned operations to settle.

`request(target, protocol, payload, signal)` snapshots its complete JSON request before awaiting. Each call uses a separate stream and returns one complete JSON response. Unsupported JSON values, malformed UTF-8 or envelopes, exceeded budgets, cancellation, deadlines, and connection failures reject with a classified `ScopeTransportError`. Handler exceptions become the fixed `scope-transport/remote-failed` response; application errors must be explicit protocol-owned JSON values. A failed response does not establish that the remote handler made no durable changes, so consumers own retry identities and idempotency.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The default entry declares `ctx.scopeTransport`; `/libp2p` implements it with TCP, Noise, and Yamux. Each protocol registration dispatches a separately bounded request stream using the connection's authenticated identity. There is no application channel replication or global request-id routing map.

| Source | Responsibility |
|---|---|
| [index.ts](src/index.ts), [types.ts](src/types.ts) | Provider-neutral service and authenticated request types. |
| [libp2p.ts](src/libp2p.ts) | Direct connection, stream admission, cancellation, and teardown. |
| [libp2p-settings.ts](src/libp2p-settings.ts), [address.ts](src/address.ts) | Restart-applied listener settings and shared direct-address validation. |
| [identity.ts](src/identity.ts) | Atomic credential initialization and stored key integrity. |
| [wire.ts](src/wire.ts) | Complete JSON envelopes, UTF-8 validation, and fixed errors. |

No invariant companion is published: credentials owns durable record exclusion, libp2p owns authenticated connections, and each request validates its own complete envelope and limits. No second projection claims to mirror those authorities.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Credentials](../../credentials/credentials/README.md) — atomic owner-specific records.
- [Scope access](../scope-access/README.md) — application read grants and projections.
- [Architecture](../../../docs/architecture.md) — profile composition and capability services.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package exchanges protocol-owned data without adding model messages or tools.

#### KV Cache effect

This package does not construct or alter model requests. The consumer owns any resulting context and cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The provider deliberately requires explicit reachability and a cooperating application consumer.

- **Explicit direct reachability** — the provider has no DNS addresses, bootstrap, DHT, relay, ambient discovery, NAT traversal, or background reconnect. Each request dials its explicit target as needed.
- **No replication or scope authorization** — the transport does not expose legacy Mesh channels or infer application permission from connection admission. Consumers own grants, revocation, durable receipts, and retry state.
- **Cooperative handler cancellation** — an in-process handler must settle after its signal aborts. Disposal waits for that settlement rather than abandoning consumer work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
