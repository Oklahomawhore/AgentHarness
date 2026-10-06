# Agent Note: Independent local and peer capture destinations

Status: implemented

English | [中文](2026-10-06-independent-native-capture-destinations.zh.md)

## Problem

A person's existing Agent can own a local Task while contributing permitted file work to another person's Task. Requiring the Agent to leave its local responsibility prevents this collaboration. Sharing one runtime selection between the two destinations can attribute a completion to the wrong permission or stop an unrelated capture.

## Decision

The [native contribution consumer](../../../../packages/collaboration/scope-agent-contribution/README.md) permits one local and one independent-peer capture per ordinary Session. Each destination owns its consent, capture identity, operation cancellation, unfinished observations, completion retention, retry worker, and stop operation. `stopLocal` selects local authority; `stop` selects peer authority. A selection from the other destination is stale, never an instruction to switch destinations.

An actual filesystem mutation is evaluated separately against both live permissions. Each accepted report retains its original tool dispatch, provider, path selection, result, and Session durability checkpoint. Local reports are not forwarded to the peer. Per-capture sample limits remain independent; the service's retained-observation limit counts both destinations. Failure or withdrawal of one permission does not cancel the other.

Local authority follows the exact Task assignment epoch. Peer collection follows its independently approved Session, directories, tools, destination, and limits. Changing the local assignment terminates local collection without changing peer consent. Individual Agent disposal terminates both. Restart finishes both retained terminations without granting a replacement Agent collection permission. The separate durable domains keep their existing representations.

This replaces the capture exclusivity described by the [owner-local contribution decision](2026-10-04-owner-local-scope-contributions.md). Reading and automatic execution remain separate permissions: outgoing peer contribution does not replace the local Task or authorize receiving a foreign scope. The native receiving service retains its local-Task versus peer-subscription restriction.

## Alternatives considered

**Treat local file permission as permission for every scope.** Adding a destination changes who receives file contents. Each destination requires explicit consent and its own authority check.

**Reuse the local report for peer delivery.** Different roots, tools, byte limits and lifetimes can authorize different portions of the same operation. Reusing a completed report loses those distinctions.

**Keep one Session-wide stop and infer its destination.** Both captures are legitimate at the same time. Inference from whichever record exists first makes stop and retry affect unrelated authority.

**Terminate peer collection when the local Task changes.** Peer consent records a Session and file selection, not a local assignment epoch. Inferring that relationship would silently reinterpret existing durable consent.

## Consequences

A working Agent can contribute to another owner without giving up its local assignment or collection. Separate operation state increases lifecycle work, while the existing shared management queue still serializes durable commits. Independent-destination tests and shipped-profile Session replay establish authorization, routing, withdrawal and retained local work. They do not establish combined local-and-peer receiving, semantic model quality, or a benefit from artificial task decomposition.
