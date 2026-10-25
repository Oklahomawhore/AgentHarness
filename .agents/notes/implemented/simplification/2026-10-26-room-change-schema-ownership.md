# Agent Note: Room owns the shared change parser

Status: implemented

English | [中文](2026-10-26-room-change-schema-ownership.zh.md)

## Problem

Mesh and durable-log Consumers parse the same Room changes. Separate declarations can diverge while both represent one Room event type.

## Decision

The [Room schema](../../../../packages/collaboration/development-room/src/schema.ts) owns `developmentRoomChangeSchema`; [Mesh](../../../../packages/collaboration/development-room-mesh/src/index.ts) and [durable storage](../../../../packages/collaboration/development-room-storage-domain/src/schema.ts) consume its `./schema` export. Each Consumer retains its entry envelope: Mesh accepts numeric `at`, while durable records require nonnegative integer `at`. The Room service retains its identifier, text, timestamp, sequence, and configuration checks.

## Alternatives considered

Putting the parser in either Consumer makes the other depend on an unrelated transport or persistence implementation. Sharing the complete entry parser would erase their different timestamp constraints.

## Consequences

Room owns one payload parser without changing wire or durable formats or service limits. The [schema tests](../../../../packages/collaboration/development-room/tests/schema.spec.ts) check accepted and rejected fields while leaving Room policy validation with the service.
