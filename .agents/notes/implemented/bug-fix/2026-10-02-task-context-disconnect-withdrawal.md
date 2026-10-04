# Agent Note: Withdraw Task context after session disconnection

Status: implemented

English | [中文](2026-10-02-task-context-disconnect-withdrawal.zh.md)

## Problem

Clearing a native Agent's final Task binding left the previous Task snapshot on its model-visible Session surface. Later requests therefore continued to receive context from a scope the Agent had left. Replaying the Session preserved the same stale snapshot.

## Decision

The [Task context consumer](../../../../packages/collaboration/development-task-context/README.md) reconciles its visible messages even when the Agent has no Task binding. At the next admitted pre-step it replaces injected Task snapshots and retirement markers with a durable `disconnected` message. The replacement references the withdrawn event, preserves the original log, and contains no Task details. Repeated disconnected requests and replay reuse the marker. Reconnecting replaces it with the selected Task snapshot.

The first Task context message enters through the admitted pre-step result so Agent-loop records it after the protected system head. Later context changes use logged surface replacements. Both paths produce Session history that can reconstruct the actual model request.

This completes the withdrawal behavior of [per-session Task bindings](../architecture/2026-08-28-task-context-atoms-and-session-bindings.md); that decision remains authoritative for binding ownership and Task context selection. Ordinary conversation messages are outside this plugin's ownership and are not rewritten.

## Alternatives considered

**Return immediately when no binding exists.** This leaves the previous snapshot active and makes disconnect ineffective for model context.

**Delete the historical Task messages.** Removing committed history would lose the evidence needed to reconstruct earlier model requests. A logged surface replacement preserves both the earlier requests and the disconnected state.

## Consequences

Disconnection invalidates the request suffix from the replaced Task message onward. The marker becomes visible on the next admitted request, without waking an idle Agent. Session history retains the old Task details for reconstruction, and details repeated in ordinary conversation remain visible under their original ownership.
