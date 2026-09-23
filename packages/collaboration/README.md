---
description: "Collaboration packages provide the Task DAG, Room membership, Mesh replication, and model context injection."
kind: "package-group"
---
# Collaboration packages

English | [中文](README.zh.md)

## Summary

Collaboration packages organize humans and Agents around an immutable Task DAG. Task assignment and explicit snapshots own product context; Room remains a hidden membership runtime. A generic authenticated Mesh incrementally replicates versioned Task and Room channels.

See the [collaboration subsystem](../../docs/subsystems/development-room.md) for the shared types and runtime relationships.

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)

## Behavior

| Package | Role |
|---|---|
| `development-room` | Collaborator roster plus one append-only create/join/leave log and its room projections. |
| `development-evidence` | Bounded provider registry with explicit available, empty, denied, and failed outcomes. |
| `development-evidence-reviewed-file` | Strict reviewed JSON knowledge provider for keyless and project-local use. |
| `development-room-agent-presence` | Projects live Harness Agents into participant leases. |
| `development-room-storage-domain` | Persists one node's append-only room log and restores it on cold start. |
| `development-mesh` | Defines the versioned channel registry, peer status, publication, and owner-command operations. |
| `development-mesh-websocket` | Authenticates peers with HMAC, discovers LAN nodes, and transports incremental channel deltas. |
| `development-room-mesh` | Replicates hidden Room state and routes membership commands over the generic Mesh. |
| `development-task` | Owns Root/Fork/Merge lineage, explicit context publications, and per-session Task bindings. |
| `development-task-storage-domain` | Persists Task events, context blocks, and assignments as independent SQLite-routable rows. |
| `development-task-mesh` | Replicates Task rows and routes owner mutations over the generic Mesh. |
| `development-task-context` | Injects the bound Task context into native Agent requests and durable Session history. |
| `development-room-context` | Legacy explicit Room text service retained outside the Task-first Web composition. |
| `development-room-context-storage-domain` | Legacy Room-context persistence retained outside the Task-first Web composition. |

Presence is transient and stays outside durable logs. Task snapshots inherit only explicit Task publications and references; they never inspect private Session history. SQLite stores the Task graph as events and projections are rebuilt in memory, so no graph database is required for the bounded product queries.

In a single-node Web launch without a Mesh node or peer setting, the transport and both Room and Task replicators stay disabled. Local Tasks, Room membership, and Active Task context still work.

## Dev Note

Use the package source and tests for exact service and persistence behavior.
