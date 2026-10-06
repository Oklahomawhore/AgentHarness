# Agent Note: Joint receiving retains the participant's local responsibility

Status: implemented

English | [中文](2026-10-07-retain-local-task-during-joint-receiving.zh.md)

## Problem

People bring existing Agents, Tasks, histories and permissions to a shared goal. Requiring an Agent to leave its own Task before receiving another owner's current facts discards the responsibility that makes collaboration necessary. Independent local and remote injection can also duplicate scheduling or admit more context than the configured request budget permits.

## Decision

The [native receiver](../../../../packages/collaboration/scope-agent-context/README.md) supports an explicit combined binding to the exact existing local Task assignment and one independent read subscription. Joining retains the Agent, Session, Task epoch, tool permissions and independently authorized local capture. The caller confirms the local target and observed receiving state; ordinary work does not invalidate consent, while a later management decision does. The [joint contribution flow](2026-10-04-native-joint-join.md) retains this target with source consent.

One receiver owns request admission and automatic scheduling for both sources. It rechecks remote authorization around local computation and synchronously verifies the local assignment and provider after the final remote read. Both exact projections share one complete UTF-8 message budget, including framing and withdrawal. Their identities and source sequences are retained with actual model-request evidence. A notification or prefetched projection cannot establish adoption, completion or execution authority.

The participant separately authorizes a local goal and finite automatic allowance for the combined binding. An existing local automatic policy is retained for departure but does not authorize responses to the new remote scope. External adoption waits for the previous owned automatic turn to settle before installing the new binding. Adoption from inside that same automatic turn is rejected to avoid waiting on itself. Genuine concurrent pause, departure and rebind decisions supersede pending adoption. Consumed Session allowance remains monotonic. A pending combined plan pauses the original policy; failed or cancelled adoption does not resume it implicitly.

Departure removes the owned remote subscription and restores a fresh local scheduling interval for the retained assignment. A retained automatic policy is paused and retains its goal, limit and consumed allowance; pending pulses and completed-response baselines do not return. An obsolete local assignment cannot authorize a response, and departure does not clear a replacement Task. Independent file capture continues under its own consent. A later explicit resume requires current authority and remaining allowance.

The combined binding and dual-source evidence have strict versioned plugin payloads. Historical local-only and remote-only records retain their original interpretation. This does not change the Session container format or rewrite committed Session generations. [Independent capture destinations](2026-10-06-independent-native-capture-destinations.md) continues to own report permissions and termination.

## Alternatives considered

**Move the participant to the owner's Task.** This removes the existing human responsibility instead of connecting its Agent, and changes which authority owns ordinary work.

**Run two injectors and two schedulers.** Independently valid inputs can exceed a single request budget, and one change can start duplicate automatic work. Combined admission retains both sources under one local execution decision.

**Copy local automatic permission into the shared scope.** The user authorized a different context and goal. Retaining the original policy for paused restoration preserves it without extending its authority.

**Reject every join while local automatic work is active.** An external confirmation can wait for owned work to settle. Requiring another approval would make normal joining depend on incidental timing; only self-wait and superseded consent require rejection.

## Consequences

Existing work can receive another owner's facts without a recall call or Task migration. The receiver must maintain two independent evidence sources and revalidate them at admission; this is not an atomic distributed snapshot. Passive receiving waits for an ordinary request. Automatic responses remain optional and bounded, and restarting does not restore execution permission.

Behavioral verification covers stale consent, active-turn settlement, dual-source budgets and evidence, current-fact replacement and paused local restoration. Shipped-profile SDK and browser scenarios exercise existing local work through joining and departure. Controlled model responses establish these mechanisms, not real-model quality, two-person usability or public-network reachability.
