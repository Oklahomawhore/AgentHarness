# Agent Note: Recipient evidence controls automatic activation

Status: implemented

English | [中文](2026-10-03-recipient-evidence-activation.zh.md)

## Problem

Repeated samples can change source identifiers, versions, and audit history without changing the facts relevant to a recipient. Starting automatic work for every exact projection consumes the finite collaboration allowance on those changes. Comparing less information also creates a risk: a correction, conflict, withdrawal, or missing current evidence can disappear from scheduling even though the model still needs it.

## Decision

The [recipient context backend](2026-10-02-recipient-task-context-backend.md) returns an activation descriptor alongside its exact text and complete source coverage. `exact` retains exact projection comparison. `recipient-evidence` supplies a versioned digest and current-coverage status for a backend that defines a deterministic recipient comparison. This descriptor decides whether another automatic turn is useful; it neither authorizes a read nor replaces the model input or its audit record.

The deterministic OpenAPI facts provider compares the explicitly routed current declarations. Its digest preserves Task instructions, backend configuration, independent source and authorization identities, absent fields, invalid or unavailable evidence, conflicts, and terminal notices. Conflicts include every supported fact field. Sample identifiers, sequence numbers, file hashes, timestamps, and superseded history remain in the Task audit log but do not independently trigger work. Delivered text and selected or omitted source references remain exact. Frozen inherited evidence remains historical. A change that occurs and reverses between reads remains auditable without a claim that the model processed every intermediate state.

A whole current evidence group or terminal notice omitted by the byte limit produces `blocked-current`. The native consumer pauses automatic work, withdraws current context, and establishes no completed baseline from that projection. It does not fall back to an older valid sample. Omitting superseded or frozen historical records alone does not block current evidence. Complete model text, including consumer framing, must fit before any equality decision can suppress work.

Exact comparison does not imply complete evidence. The native consumer also blocks automatic work when any backend reports a `budget` omission for a publication attributed to the current Task and revision. The shared check runs at idle activation and at each automatic request admission, so a newly oversized update cannot pass after a pulse was reserved or after a tool step. It spends no new reservation at idle; an existing reservation remains charged. A blocked automatic continuation without new human input is rejected. Mixed input retains the ordinary human work and explicit context withdrawal. Ordinary text-backed user requests still receive bounded context and omission information. Non-budget omissions alone do not trigger this additional check.

[Scope access](../../../../packages/collaboration/scope-access/README.md) binds the descriptor into the version 2 projection hash. Strict parsing preserves the original hash of unversioned exact records and rejects incomplete versioned records. Those unversioned records use exact comparison. Every scheduling evaluation still retrieves online and checks current read authority; a matching digest is never an offline permission lease. Committed Session generations are unchanged.

The [native consumer](2026-10-03-native-scope-change-delivery.md) advances its baseline only from an authorized automatic reservation, an actual frozen AgentLoop request, a non-interrupted assistant message for that request, and a completed whole turn. The first request must carry the matching local pulse. That request establishes automatic turn ownership for later steps even if compaction removes the historical pulse. Each new step clears the previous dispatch candidate; the last actual request supplies the baseline context. A final request without a scope snapshot cannot borrow an earlier step. Completion records execution of the goal attempt, not proof that the goal was achieved.

Evaluation events retain the exact candidate projection and references to the completed baseline; request events reference the exact logged context actually dispatched. Ordinary user turns and prefetches do not establish an automatic baseline. Suppression requires the same local binding, explicit goal, authority, and backend comparison. Rejoining or changing the goal cannot reuse the completed baseline. Renewal of the same goal can reuse completed equivalent evidence; allowance and pacing alone do not make facts new. A suppressed idle evaluation spends no reservation, while a pulse already reserved before admission remains charged. Restored automatic bindings remain paused until explicit renewal.

Pause, leave, replacement, and consumer unload cancel the owned automatic activity before it can continue as ordinary work. Ownership for cancellation starts with the actual Inbox claim, before another pre-step listener can suspend. Unsubmitted user or plugin claims return once to the Inbox. A mixed request already dispatched is interrupted without replaying its user input; an ordinary turn without owned automatic activity is not cancelled by leaving the scope. Rebinding and renewal await the old activity before committing new permission and recheck the live Agent and command identity. Disposal drains the cancelled activity.

The typed `agent/cancel-requested` event reports every cancellation call, including calls after the activity signal is already aborted. It preserves the first abort cause while making a later Stop invalidate a pending bind or resume. The consumer excludes only the exact cause object of its own synchronous cancellation; a reentrant user Stop still takes precedence. Its listener changes command ordering without appending Session events. This event is necessary because an already-aborted signal cannot report a second cancellation request.

## Alternatives considered

**Compare only exact projection identifiers.** This remains the fallback for text and other exact providers. It cannot distinguish a new sample record from new recipient evidence, so it spends automatic work on audit-only changes.

**Strip metadata from rendered text and hash the remainder.** Presentation does not define evidence identity. Removing apparent metadata can erase source changes or conflict attribution, and text formatting can create false differences. The facts provider owns the comparison alongside its source reduction.

**Mark prefetch, admission, or one successful step as completed work.** None proves that the final actual request contained the evidence and the whole automatic turn completed. Failed, cancelled, truncated, or later context-free requests cannot advance the baseline from an earlier candidate.

**Use any successful user request as the automatic baseline.** A user can ask unrelated questions while receiving scope context. That request does not establish an attempt at the separately authorized automatic goal.

## Consequences

The facts provider's recipient comparison covers explicit OpenAPI field routes and their deterministic evidence states. It is not general semantic similarity or embedding communication, and it does not verify deployed API behavior. The text and [reported-file](../feature/2026-10-07-reported-file-context.md) backends use exact comparison. Those providers do not judge semantic relevance, so any current publication omitted for capacity blocks automatic work even if a person considers that publication unrelated. Source admission, exact projections, and audit storage still grow with observations; this decision reduces redundant automatic model turns rather than discarding their provenance.

Backend fixtures verify stable comparison and meaningful invalidation. Real Loader and AgentLoop tests verify frozen-request attribution, multi-step completion, replay, cancellation, mixed claims, renewal, and unload with a controlled scope service and keyless LLM adapter. The keyless SDK `scope-owner-idle` scenario sends a complete oversized report through real peer file capture after a completed automatic turn, then verifies a coverage pause without another reservation or dispatch. These tests establish scheduling and log semantics; they do not establish model reasoning quality, successful real-world collaboration, or a physical cross-device deployment.
