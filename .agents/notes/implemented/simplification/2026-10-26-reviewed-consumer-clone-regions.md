# Agent Note: Keep reviewed short statements with their operation owners

Status: implemented

English | [中文](2026-10-26-reviewed-consumer-clone-regions.zh.md)

## Problem

Consumers repeat short statements around independently authorized operations. Extracting these fragments can add policy parameters or lifecycle state without removing an existing responsibility.

## Decision

The [Room change parser](2026-10-26-room-change-schema-ownership.md), [Client snapshot store](2026-10-25-client-inventory-snapshot-store.md), native permission/root resolution, and command-result normalization share actual mechanisms. Exact local `jscpd` markers retain reviewed short repetitions beside their operation owners.

Descriptor identity and UTF-8 policy, domain append records, versioned result reconstruction, peer attribution, and tool completion notifications remain consumer-owned. Wait/read and local/remote activation retain independent checks after asynchronous work; contributions recheck after persistence. Each cursor retains complete-byte pagination. UI refresh, nullable identity, settings revisions, replay registration, and study source permission/evidence cleanup retain their existing state and transaction owners. Repeated statements can implement the same algorithm; independent ownership and abstraction cost justify these limited exceptions.

## Alternatives considered

A generic pipeline needs callbacks, identity variants, or another lifecycle owner. Making one transport or storage Consumer depend on another solely for these fragments couples otherwise independent policies.

## Consequences

The marked intervals preserve every non-trivia token. Existing [read-authority](../../../../packages/collaboration/scope-access/tests/subscription-route.spec.ts), [publication reconstruction](../../../../packages/collaboration/development-task/tests/publication-projection.spec.ts), and [tool completion](../../../../packages/fs/tool-fs/tests/integration.spec.ts) tests retain behavioral verification. The [quality gates](../process/2026-06-11-quality-gates.md), global clone scope, and thresholds remain unchanged; no whole adapter is excluded.
