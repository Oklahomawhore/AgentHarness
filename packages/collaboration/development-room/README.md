---
description: "Host service for discoverable realtime topic rooms"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room

English | [中文](README.zh.md)

## Summary

Host service for discoverable realtime topic rooms. It owns a bounded collaborator roster and one append-only room log. The log contains only `room-created`, `participant-joined`, and `participant-left` changes; room snapshots and the complete directory are projections of those entries.

## Table of Contents

- [Behavior](#behavior)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

Every entry carries its originating node, one node-wide sequence, timestamp, room id, and typed change. A room remains attached to the node that created it. Only that node appends membership changes, while a mesh provider forwards join and leave requests for replicas. Duplicate entries with identical content are idempotent; gaps or different content at one node and sequence fail as conflicts.

Creation starts with no participants. An announced participant may explicitly join or leave, and repeated requests append nothing. Presence and membership are independent: lease expiry does not leave rooms, leaving does not change presence, and an announced offline participant may still change membership.

`log()` returns the complete retained log in local append order. Before a locally authored entry becomes observable, the service sends `development-room/persist`; a rejecting listener rejects the operation and preserves the previous log and projections. After append, `development-room/changed` carries the new projection and exact entry. Presence changes use `development-room/presence-changed` and never enter the room log.

`restoreLocalLog()` replays locally authored durable entries without writing them again. `acceptLogReplica()` appends authenticated peers' entries without persisting them locally. `@deepseek-ai/dsh-development-room-storage-domain` and `@deepseek-ai/dsh-development-room-mesh` supply those Consumers.

## Configuration

| Key | Meaning |
|---|---|
| `nodeId` | Stable lower-kebab identity for this process and its locally authored log entries. |
| `presenceTtlMs` | Time since the latest announcement or heartbeat for a participant to remain online. |
| `maxParticipants` | Maximum global roster size retained by this process. |
| `maxRooms` | Maximum number of room projections retained by this process. |
| `maxTextBytes` | UTF-8 byte limit applied independently to every human-readable field. |

All fields are required and validated at load. Room creation accepts one nonblank topic in `objective`. Caller-supplied node and participant ids use lower-kebab-case; server-created room ids are opaque.

## Model Experience

None, as the room-link service registers no prompt, tool, message, or model input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The log has no compaction or deletion; deployment storage grows with real membership changes.
- Remote entries and participant profiles are rebuilt from configured peers after restart.
- Context selection, shared-agent behavior, and rich collaboration presentation belong to later plugins.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
