# Agent Note: Restore one-install-one-node onboarding

Status: implemented

English | [中文](2026-08-26-single-node-onboarding-topology.zh.md)

## Problem

The root one-command launcher incorrectly used the three-container collaboration acceptance as the product installation topology. It started frontend, backend, and algorithm Docker nodes for every colleague. In the real deployment, one colleague installs and runs one AgentHarness process, and collaboration links those independently owned nodes across colleagues.

That topology error created a second false problem for existing DeepSeek Harness users. Because the product process had been moved into three isolated Linux homes, their active host Web-profile plugins disappeared. A plugin exporter and three-way container importer were then added to bridge state across a boundary the product should never have crossed.

## Decision

The root `start` command now starts exactly one local AgentHarness Web process. It installs dependencies and builds the source checkout when needed, binds the ordinary Web server on port `3080` by default, waits until the listener is ready, opens the local page, and remains in the foreground until the user stops it. It does not invoke Docker and does not prepare role-specific business repositories.

The local process resolves the same `$DSH_HOME`, or `~/.dsh`, and the same `web` profile as DeepSeek Harness. This is the plugin compatibility path: existing bundle dependencies, layer order, `cordis.patch.yml`, skills, sessions, settings, credentials, and storage remain active in place. No artifact export, profile copy, fingerprint, or reinstall is required. Later plugin changes made through the ordinary `dsh plugin --profile web` flow are visible on the next AgentHarness start.

The launcher preserves an explicitly configured `DSH_ROOM_NODE_ID`, then an existing non-legacy owner id from the profile's durable room log. A fresh profile persists a human-readable host slug plus a random suffix in `$DSH_HOME/agentharness-node.json`; legacy `standalone` room and context logs are backed up and atomically reassigned before boot. This order keeps existing room storage readable while giving new installations a collision-resistant zero-configuration identity. The later [LAN discovery decision](../architecture/2026-08-26-development-room-lan-discovery.md) makes multi-node collaboration automatic inside the room mesh while retaining explicit peers as a fallback.

The three-node Docker topology remains under `acceptance/development-room` and its `development-room:up` command. It continues to model three independently owned nodes for collaboration regression, but it is no longer the root installation path. The host-plugin exporter, container importer, import fingerprint, and plugin-driven container recreation are removed from that acceptance fixture.

The tracked provider endpoint and shared key are unchanged.

## Alternatives considered

**Keep three Docker nodes as the default and improve the copy layer.** Rejected because it preserves the wrong ownership and deployment model even if plugin transfer succeeds.

**Export each installed plugin and reinstall it into all three containers.** Rejected because package archives and fingerprints solve a compatibility problem created only by the false container boundary. They also duplicate a user's profile and can introduce host-to-Linux package differences.

**Create a separate AgentHarness home and copy selected DeepSeek Harness state into it.** Rejected because the product is an integrated Harness distribution, and splitting the home would make plugin order, patches, credentials, sessions, and storage diverge.

**Reduce collaboration acceptance to one node.** Rejected because a collaboration E2E must still exercise multiple independent processes and replication links. The fix separates acceptance topology from installation topology instead.

## Consequences

- One colleague's install and foreground process correspond to one AgentHarness node.
- Existing DeepSeek Harness plugins and user state continue without clone or migration because AgentHarness runs the same Web profile.
- The default onboarding command requires Git and Node, but not Docker, preinstalled pnpm, provider input, or another startup command.
- Same-multicast-domain collaboration discovers reachable AgentHarness peers automatically; routed or multicast-suppressed networks still need explicit peers.
- The fixed three-node environment remains available for collaboration acceptance and no longer mutates its nodes based on the host plugin profile.
- The shared provider configuration remains authoritative and unchanged.
