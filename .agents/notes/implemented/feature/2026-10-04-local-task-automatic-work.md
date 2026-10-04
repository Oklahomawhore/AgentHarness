# Agent Note: Local Task automatic work shares the native scope scheduler

Status: implemented

English | [中文](2026-10-04-local-task-automatic-work.zh.md)

## Problem

A Task creator's Agent receives other participants' context during a natural request. It also needs to react while idle, without granting another Host execution authority or asking its owner to relay each update. A separate local scheduler would duplicate reservation, cancellation, recovery, and completion rules. Treating local assignment as a remote subscription would invent peer authorization that does not exist.

## Decision

The [native scope consumer](../../../../packages/collaboration/scope-agent-context/README.md) manages local and remote receiving with one bounded scheduler. A local binding fixes the existing ordinary Agent, owner-local Root Task, participant, Task binding, and checkout epoch. Its explicit goal and finite policy authorize automatic turns independently of [file contribution](../../../../packages/collaboration/scope-agent-contribution/README.md). Cumulative consumed allowance survives rebind and restart. Restored automatic intent stays paused.

The [Task context consumer](../../../../packages/collaboration/development-task-context/README.md) delegates managed local admission through its typed extension point. A shared local reader captures the authoritative view and rechecks the binding, backend, and terminal evidence. One exact snapshot supplies model input and durable request evidence. A queued pulse, prefetch, or Task acknowledgment cannot advance completed work; only the actual frozen request followed by successful whole-turn completion can do so. Existing passive and remote records retain strict readers, and committed Session generations remain unchanged.

Committed changes mark a local binding for reconsideration. The Agent's own ordinary file reports do not trigger another idle turn, while explicit publications and terminal updates remain observable. Expiry requires reconsideration even without an external notification. This filtering does not prove semantic convergence between independently responding participants; finite execution allowance remains necessary.

Pause cancels this feature's owned automatic activity while retaining passive reads and separately authorized capture. Leaving the local Task first invalidates automatic intent, then clears only the displayed checkout epoch in the Task owner queue. The clear operation ends its local contribution intervals before removing the assignment. A stale leave cannot clear a newer checkout; persistence failure remains visible instead of reporting a completed departure.

## Alternatives considered

**Create a local scheduler.** Duplicated budgets and completed baselines could disagree about the same Agent. The existing scheduler owns both authority variants.

**Inject local and remote messages independently.** Two consumers could retain competing current facts or admit a pulse without the matching projection. Managed local admission has one owner and does not depend on listener registration order.

**Treat all Task revisions as new work.** The exact text backend includes revision and coverage metadata, so the Agent's own file report can change bytes without supplying new outside work. Trigger filtering limits that specific feedback path; provider evidence still decides whether completed work is current.

## Consequences

Both the Task creator and an independent recipient can authorize bounded idle work in their existing native Sessions. Joining, file collection, and automatic execution remain separate decisions. Local automatic work uses the same receiving backend and source history as passive local work, without a self-peer invitation. It does not establish model quality, cross-machine latency, or a generic solution to duplicate work across participants. Current exact and semantic text providers do not implement latent-vector communication.
