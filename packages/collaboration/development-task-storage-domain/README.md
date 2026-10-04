---
description: "@deepseek-ai/dsh-development-task-storage-domain persists context-only Task events, content-addressed inherited blocks, and Agent-session binding events as"
kind: "package-reference"
---
# Development Task storage domain

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-task-storage-domain` persists context-only Task events, content-addressed inherited blocks, and Agent-session binding events as independent storage rows. It waits for `developmentRoomStorageReady`, restores blocks before Task events and bindings after the Task projection, then reconciles locally owned hidden Rooms. The startup barrier prevents Task recovery from creating Room events before the durable Room log has restored its sequence head.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

The `development_context_tasks` domain uses format version `1` and rejects mismatched records. Event identity is `(origin node, sequence)`, and each Task event carries its Task-local revision. A context block is written before the Task creation event that references it; startup removes blocks older than `orphanGraceMs` when no event references them.

Trusted Mesh observation intervals and independent peer contribution grants use the same event table for approval and termination. Recovery reconstructs terminal withdrawals and receipts from their original owner events; it does not require the source Host to remain online. An interval ended before approval retains its terminal record after restart. Receipts identify durable owner admission or termination, not model consumption.

Optional observation metadata, peer publication branches, and authorization events preserve the existing row keys and records. They require no SQL migration or domain-version change; records without observation metadata and content-addressed inherited blocks remain unchanged. [Task admission](../development-task/README.md) owns provenance, binding checks, authorization, and original-event receipts. Peer publication cloning uses canonical field order so strict durable parsing preserves new inherited-block hashes as well as legacy hashes.

The Web bundle routes `development_context_tasks` to SQLite. The lifecycle-era `development_tasks` domain and Mission records are not mounted or imported, so incompatible records remain untouched rather than preventing startup. Replicated current-format rows remain readable while their owner is offline.

## Model Experience

None, as the Task storage Consumer registers no prompt, tool, message, or model input.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The append-only rows have no compaction operation.
- Backup and restore are file-level operator procedures; online multi-writer SQLite is not supported.

No invariant companion is published because the Task service owns replay validation, and this adapter rejects conflicting row identities before writing.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
