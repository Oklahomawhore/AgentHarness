# Agent Note: Tasks are context atoms with per-session Agent bindings

Status: implemented

English | [中文](2026-08-28-task-context-atoms-and-session-bindings.zh.md)

## Problem

Task lifecycle stages, plan evidence, review, and completion controls turned a context-sharing action into a governance workflow. The first usable path required fields that users did not understand, creation appeared in two places, and Agent connection was hidden behind a small tab. A participant-wide Active Task also made every Codex conversation appear coupled even though users wanted to connect only selected sessions. During upgrades, an old browser page could keep the runtime connection open and make a piped installer wait indefinitely.

## Decision

**A Task is only a shared-context atom.** Its durable state is immutable lineage, a name, initial shared context, explicit publications, and runtime health. Root, Fork, and Merge remain, but stage, transition, evidence, approval, completion, checkpoint, and audit APIs, events, MCP tools, and UI controls are removed. Governance can be expressed as published context or supplied later by a separate optional plugin; it is not a prerequisite for sharing context.

**Agent connection is scoped by an explicit binding id.** MCP configuration remains client-wide, but each Codex, Cursor, or Claude conversation calls `agentharness_task_connect` only when that session should join. Omitting `bindingId` creates an independent binding; later calls from that conversation retain the returned id. Reusing an existing id switches only that binding. Multiple bindings for one participant may point to different Tasks, and disconnecting one does not affect the others. Mutating Task context requires the calling session's binding and Task to match.

**The UI has one creation entry and a prominent Agent-session section.** The header owns Root, Fork, and Merge creation. The selected Task immediately shows how a specific Agent session connects and lists observed bindings; no lifecycle tabs or browser-wide assignment action exist.

**Portable upgrades have a bounded stop.** The launcher sends termination to the recorded detached process group, waits two seconds for graceful shutdown, then force-terminates the group and bounds the final wait. It validates the recorded command and PID before signaling. Download requests also have a finite timeout. An open page may lose its old connection during upgrade, but it cannot block installation indefinitely.

**Context-only data uses a new storage domain.** `development_context_tasks` version `1` rejects mismatched data. The earlier lifecycle-era domain remains untouched and unmounted; the pre-release product does not import it implicitly.

## Alternatives considered

**Keep lifecycle controls as an optional mode in the same Task service.** Rejected because every type, screen, and Agent instruction would still carry two meanings for Task and recreate the confusing default path.

**Use one Active Task per MCP participant.** Rejected because MCP configuration identifies the client integration, not one particular conversation. Changing a global assignment from one conversation would contaminate another.

**Let the browser assign an Agent globally.** Rejected because the browser cannot prove which external conversation intends to join. The selected conversation must make the connection call itself.

**Wait indefinitely for graceful shutdown.** Rejected because browsers and long-lived transports can keep the server open after normal termination, making `curl ... | sh` appear hung.

## Consequences

Creating a Task requires only identity, Task name, and initial shared context. Agent cards are visible without tab discovery, and multiple sessions of one Codex installation can connect to different Tasks. Sessions must retain their own binding id; the shared MCP configuration alone does not imply Task membership. A forced stop can interrupt in-flight requests after the grace period, which is preferable to an unbounded installer.

Verification covers the absence of lifecycle fields and tools, independent same-participant bindings, binding-scoped mutation and disconnect, the single creation entry, prominent Agent guidance, Root/Fork/Merge browser behavior, readable graph sizing, and a live old-page connection during bounded portable upgrade.
