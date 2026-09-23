---
description: "Durable Consumer for one node's append-only room log"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room-storage-domain

English | [中文](README.zh.md)

## Summary

Durable Consumer for one node's append-only room log. It opens the versioned `development_rooms` storage domain, validates the single local log record, restores its entries before loading completes, and appends each new local candidate before `developmentRooms` publishes it. After recovery and listener installation it provides `ctx.developmentRoomStorageReady`, so dependent recovery Consumers cannot materialize deterministic Rooms against an empty projection.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

The stored record contains only room-log entries: originating node, node-wide sequence, timestamp, room id, and typed create/join/leave change. Transient participant profiles, presence, and remote entries are rebuilt from live leases and configured mesh peers after restart.

A rejecting storage write rejects the caller operation and leaves the previous in-memory log visible. Operations remain serialized after a failed write, so a retry uses the same next sequence. Startup rejects invalid records, foreign-node records, sequence gaps, and projection conflicts.

The default Web bundle mounts this Consumer after `development-room`. Deployments select the actual storage backend through `@deepseek-ai/dsh-storage-domain`; this package contains no database-specific code.

## Model Experience

None, as room-log persistence and recovery register no prompt, message, tool, or model input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The local log grows without truncation or compaction.
- Remote entries and participant presence are intentionally not persisted here.
- Storage-domain version `8` rejects incompatible pre-release records without migration.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
