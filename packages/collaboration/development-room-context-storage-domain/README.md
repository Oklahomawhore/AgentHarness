---
description: "Durable Consumer for one Host's append-only shared-room context log"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room-context-storage-domain

English | [中文](README.zh.md)

## Summary

Durable Consumer for one Host's append-only shared-room context log. It opens the versioned `development_room_context` storage domain, restores the single local record before loading completes, and persists every next candidate before `developmentRoomContexts` publishes it.

A rejecting storage write rejects the share operation and leaves the previous in-memory log visible. Startup rejects malformed records, foreign-node records, sequence gaps, and conflicting repeated positions. Room membership remains owned by `development-room`; restored context records can wait for a remote room directory to reappear.

The default Web bundle mounts this Consumer after `development-room-context`. Deployments select the storage backend through `@deepseek-ai/dsh-storage-domain`; this package contains no database-specific code.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Model Experience

None, as shared-context persistence and recovery register no prompt, message, tool, or model input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The local context log grows without truncation or compaction.
- Remote context entries are not represented until a context-layer transport exists.
- Storage-domain version `1` rejects incompatible pre-release records without migration.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
