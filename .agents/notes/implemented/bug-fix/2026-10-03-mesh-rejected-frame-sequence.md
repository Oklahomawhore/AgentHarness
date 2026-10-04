# Agent Note: Preserve Mesh sequence continuity after rejected frames

Status: implemented

English | [中文](2026-10-03-mesh-rejected-frame-sequence.zh.md)

## Problem

The WebSocket provider assigned a connection sequence before serializing and checking its frame. Rejecting an oversized request consumed a sequence that the peer never received, so the next valid command failed replay validation. An oversized response also prevented its smaller error response from reaching the caller.

## Decision

The [Mesh WebSocket provider](../../../../packages/collaboration/development-mesh-websocket/README.md) constructs the candidate sequence and validates the complete serialized envelope before committing the sequence immediately before `socket.send`. No asynchronous work separates these operations, so concurrent callers cannot reuse a sequence. Rejection before sending leaves the connection usable for the next bounded command or error result.

The existing [Mesh architecture](../architecture/2026-08-27-emergence-center-task-lineage.md) still owns authenticated transport and replay rejection. This correction does not change wire fields, receiver ordering, channel event identities, or durable Session formats.

## Alternatives considered

**Allow gaps in receiver sequences.** This weakens replay and ordering checks to accommodate frames the sender knows were never sent.

**Rollback every failed send.** A socket error can occur after bytes have reached the peer. Reusing that sequence would create a duplicate; only validation before sending can safely leave the sequence unassigned.

## Consequences

Oversized frames do not invalidate the sequence of subsequent bounded traffic. The byte limit remains unchanged. Large replication deltas still need bounded pagination, and ambiguous socket-write failures do not roll back assigned sequences.
