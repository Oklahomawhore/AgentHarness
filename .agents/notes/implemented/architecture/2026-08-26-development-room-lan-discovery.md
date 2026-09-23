# Agent Note: Keep LAN discovery inside the generic development Mesh transport

Status: implemented

English | [中文](2026-08-26-development-room-lan-discovery.zh.md)

## Problem

One installation already corresponds to one independently owned AgentHarness node, but collaboration still required every colleague to assign a node id and exchange a complete peer topology. Static lists made the first shared Task depend on out-of-band coordination, became stale when addresses changed, and turned each new participant into an update on every existing node.

The fixed three-container Docker topology proves multi-node behavior but is not a product directory. The root launcher must not recreate that fixture or own the lifecycle of remote nodes.

## Decision

The generic `development-mesh-websocket` provider owns LAN discovery beside authentication, replication, and reconnect. Each active node sends a bounded, strictly validated UDP multicast announcement containing a product marker, discovery protocol version, derived cluster id, process instance id, stable node id, Web port, and Mesh path. The complete announcement is HMAC-SHA256 authenticated with the cluster credential. Receivers derive the host address from the datagram source instead of trusting an advertised address. Announcements use a link-local multicast TTL; a goodbye announcement or lease expiry removes a discovered peer.

For each discovered node pair, the lexically lower stable node id owns dialing and the other side accepts. This deterministic rule creates one WebSocket without a coordinator. The provider dynamically adds, updates, reconnects, and removes discovered peers while retaining configured peers as an explicit fallback. Unknown inbound node ids remain rejected until discovery or configuration establishes the peer.

The root launcher owns only installation identity because it already resolves `$DSH_HOME` before Cordis configuration is evaluated. A fresh home receives a human-readable host slug plus random suffix in a mode-`0600` identity record. Explicit ids and valid non-legacy durable owners retain precedence. Legacy `standalone` room and context JSON records are backed up and atomically rewritten to the generated id before boot. The launcher still starts one process and never enumerates peers.

The Web bundle enables discovery for launcher-created nodes with an empty configured topology. Mesh startup resolves `AGENTHARNESS_MESH_SECRET` through the credentials provider, rejects missing or shorter-than-32-byte values, and derives only a non-secret cluster id and fingerprint for status. Discovery authenticates cluster nodes and message integrity; it does not provide confidentiality, individual participant authorization, or cross-LAN routing.

## Wire and lifecycle rules

Discovery datagrams have a configurable byte limit and reject unknown fields, protocol versions, invalid ids, invalid ports, and mismatched cluster or path values. The runtime ignores its own process instance, reports a different instance reusing its stable node id, refreshes peer leases only from valid announcements, and closes announcement timers, UDP sockets, reconnect timers, WebSockets, and pending commands during dispose.

The automatic scope is one IPv4 multicast domain. Routed VLANs and networks that suppress multicast require explicit peers or a later company-internal rendezvous provider.

## Alternatives considered

**Put peer discovery in the root launcher.** Rejected because the launcher would become a second topology controller, could not react to peers joining or leaving after boot, and would couple product startup to one transport implementation.

**Use the Docker node list as the company directory.** Rejected because acceptance containers are test processes on one machine, not independently owned colleague installations.

**Use a model-provider key to authenticate announcements.** Rejected because model-provider access and Mesh identity have different rotation, disclosure, and authorization domains. The dedicated cluster credential is stored separately and never appears in announcements.

**Require a central rendezvous service immediately.** Rejected because same-subnet company alpha use has a current multicast path and no deployed directory service. A routed provider can be added behind a separate discovery implementation when that deployment exists.

**Adopt a general DNS-SD dependency.** Rejected for this milestone because the current maintained candidates either provide advertising without browsing or expose CommonJS-only entrypoints that violate the source-launch ESM requirement. The product needs one fixed, bounded announcement rather than a general service catalog.

## Consequences

- The existing one-line command starts one stable node, provisions the cluster credential before first boot, and needs no peer environment variables.
- Three nodes with no static peer list converge to one authenticated full Mesh, replicate Room and Task channels incrementally, expire departure, and reacquire a restarted node without reconfiguration.
- Existing explicit peers and non-legacy durable ids remain readable; legacy `standalone` local logs migrate with backups while unrelated Harness state remains untouched.
- The cluster secret never appears in discovery frames, logs, status, or UI; only its derived id and fingerprint are displayed.
- Multicast availability remains a property of the local network and host firewall. Routed or multicast-suppressed segments and IPv6-only LANs use explicit peers until another discovery provider exists.
- Node ids and HMAC authenticate cluster membership, not individual colleagues, and LAN traffic remains readable to a passive observer.

## Verification

- Launcher tests cover fresh and repeated identity, explicit and durable owner precedence, legacy room/context migration with backups, malformed state, dry-run behavior, and default `0.0.0.0` binding.
- The Mesh package test opens real UDP multicast sockets for three Web nodes with empty static peer lists, asserts deterministic full-Mesh dial ownership and Room and Task replication, exercises replay and wrong-secret rejection, disposes one node, then restarts the same stable node id and verifies delta reacquisition.
- The portable release tests provision, preserve, inspect, reject accidental replacement of, and explicitly replace the owner-only cluster credential.
- Focused typecheck, Oxlint, Web composition tests, documentation gates, and the Docker image build cover the changed package and launcher surfaces.
