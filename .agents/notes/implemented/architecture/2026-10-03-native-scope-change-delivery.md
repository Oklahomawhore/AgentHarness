# Agent Note: Native scope change delivery and bounded idle turns

Status: implemented

English | [中文](2026-10-03-native-scope-change-delivery.zh.md)

## Problem

A native Agent with independently owned context needs current authorized facts when its collaborator changes a Root Task. Requiring a recall call misses facts the Agent does not know to request. Starting a turn for every network notification can consume unbounded work, revive cancelled input, or mistake an old projection for current authority.

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.md) provides an authenticated bounded `waitForChange` operation in addition to independent retrieval. Its opaque cursor covers the owner, grant and receiver generations, Task revision, and backend identity/configuration. A matching cursor waits for a change until a configured deadline; an absent cursor calibrates online. Notifications contain no facts. A cursor is not an authorization lease, an adoption receipt, or permission to start a model request.

Waits have independent cancellation and latest-wait ownership, so they do not supersede retrieval. Explicit wait capacity remains below transport request capacities, and the wait deadline remains below access and transport deadlines. A waiting receiver leaves capacity for ordinary reads and management. Revocation, expiry, local leave, unavailable owners, and cancelled waits remain distinct outcomes. Changing backend identity can invalidate a cursor without claiming that the underlying Task facts changed.

[Native scope context](../../../../packages/collaboration/scope-agent-context/README.md) binds one already live ordinary Session to a separate read subscription through authenticated local management. Binding is mutually exclusive with a local Task assignment; responsibility is routing information, not an ACL. Binding with no automatic policy only enables request-time reads. A local automatic policy supplies a goal, an absolute lifetime activation limit, a per-turn step limit, and a minimum interval. Remote source text cannot grant this permission.

Busy changes mark the binding dirty without adding input or forcing another step. At a natural pre-step, the consumer performs an independent online retrieval and checks the current Agent, binding, cancellation, terminal state, and complete UTF-8 text limit before adoption. An idle authorized binding coalesces notifications and owns at most one prefetch; a short Agent maintenance activity then reserves a budget unit and queues one locally sourced goal pulse. The admitted pre-step reads again rather than using the prefetch as an offline authorization lease. A newer change does not invalidate an otherwise authorized captured projection and starve delivery; it remains pending for a later request.

Session events persist the current binding, policy, cumulative reservations, and pending activation identity. The projection also folds durable `turn/end` events to clear pending activation and pause an enabled policy after a non-completed turn. This avoids writing another Session event from its post-commit notification, where reentrant append is forbidden. Explicit pause reasons remain intact. Reservations are not refunded after cancellation, leave, rebinding, or restart, and replay rejects a decreasing reservation count. Restored bindings remain passive or paused until explicit renewal; restoring a Session does not replay its pending automatic work.

Exact context is a logged user-role message with its original projection and authority metadata. First admission uses the Loop's normal message batch after the protected system head. Subsequent messages replace only owned visible nodes, preserving historical events. Denial or unavailability replaces active context with a withdrawal. These operations do not erase facts quoted by ordinary messages or prove that a model forgot earlier input.

Cancellation in maintenance synchronously pauses local automatic permission and removes only owned pulses. The listener remains installed through settlement of the returned maintenance promise. Loop cancellation clears a pre-existing wake latch while retaining requested inbox data; a send that began before a reentrant cancellation cannot restore that latch, while a later explicit send may wake new work. During idle network prefetch there is no active Agent activity to cancel, so `scopeAgentContext.pause` is the policy-wide stop operation. A rejected automatic pulse does not discard user or plugin work claimed in the same batch. The public `agent/inbox/claimed` event supplies the input identity and turn before any pre-step listener can append context. Those records, not mutable waterfall payloads or derived context, determine whether independent work remains authorized; each pre-step consumes its records, and turn completion or disposal clears leftovers.

Completed-request comparison and stopping owned automatic activities are defined by the [recipient evidence decision](2026-10-03-recipient-evidence-activation.md).

## Alternatives considered

**Push every notification into the Inbox.** This can force extra busy steps and leave stale triggers after cancellation. Dirty state and a single owned idle activation preserve natural busy request boundaries.

**Reuse a fetched projection for an idle turn.** A prefetch can become unauthorized before the turn begins. Independent admission-time retrieval preserves the online authority requirement.

**Let `turn/end` observers append scheduling events.** Session observers run while the original append is being published. A pure projection fold of the already durable ending provides the same state without reentrant writes or deferred ordering races.

**Treat every proposed message as user intent.** Another plugin can append context to a pure automatic pulse. Only input actually claimed from the Inbox establishes separate work that survives automatic permission failure.

## Consequences

Automatic work is opt-in and finitely budgeted, with explicit pause and resume. Current authority remains dependent on an online owner. Failed waits can be restarted by explicit resume; unavailability never reuses cached facts. All waits, reads, timers and maintenance work have consumer-owned cancellation and disposal settlement. Historical context remains exact while current visible context can be replaced.

The focused suite mounts a real Loader composition and drives the real AgentLoop with a controlled external read service and a keyless LLM adapter. It validates idle and busy paths, exact replacement, cancellation, mixed input, late revocation, replay, complete byte limits, single-flight scheduling and lifecycle drainage. Cross-process transport and recorded model request evidence belong to their separate integration fixtures. This consumer neither wakes arbitrary external terminal sessions nor grants cross-owner write permission.
