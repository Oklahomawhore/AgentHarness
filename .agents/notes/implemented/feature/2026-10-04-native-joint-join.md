# Agent Note: One native join preserves independent receiving and contribution consent

Status: implemented

English | [中文](2026-10-04-native-joint-join.zh.md)

## Problem

An independent Task participant must transfer a contribution entry and a separate read invitation to connect one existing Agent. The authenticated application already identifies the source peer, but the user must repeat identity transcription. Reissuing invitation or binding operations after an uncertain response creates new identities and can override a later local choice. Treating contribution termination as the end of all participation also loses independently authorized reading.

## Decision

An explicit joint entry selects one native Session capture. The source confirms reading of the whole Root Task and finite collection of local file-tool results together. An optional, initially disabled local automatic-work form records a finite goal and allowance with that same application; local roots and execution policy remain source-owned and do not enter owner application or approval messages. The owner approves reading and an equal or narrower contribution grant. Existing contribution entries retain contribution-only meaning. [Scope access](../../../../packages/collaboration/scope-access/README.md) retains both authority plans before their independently recoverable commits and reports each permission separately.

The [native source](../../../../packages/collaboration/scope-agent-contribution/README.md) retains the original adoption identity and read-state sequence. A response must pass contribution invitation, receipt, and read-grant checks before it can create eligible reading work. Reading starts only after contribution activation or a verified contribution terminal receipt removes the pending application. A contribution terminal response atomically moves unfinished reading into one bounded continuation in the same source row; it does not revoke reading or grant new collection permission.

The [native receiver](../../../../packages/collaboration/scope-agent-context/README.md) persists the original subscription and binding plan, adopted Session event, and terminal cancellation. Adoption requires the original unbound read state and the same live Agent instance. Ordinary messages do not invalidate consent; later manual reading decisions do. Retrying an ended operation cannot reopen it. Invitation equality alone does not establish ownership of a binding.

Automatic responses use the participant’s local goal and existing tool permissions; owner responsibility text and collection roots do not authorize tool execution. Explicit automatic plans use join-read version 2; passive plans retain version 1. Adoption records binding and policy together, and scheduling waits for the successful Session checkpoint. The absolute lifetime allowance retains consumed reservations; an exact retry cannot increase it or undo a later pause. Before its first Context plan, source consent belongs to the accepting receiver provider; after planning it also belongs to the original Context consumer and live Agent. Unloading or replacing that instance cancels pending adoption. These runtime checks do not transfer permission across reload.

Stop cancels pending adoption and preserves reading and automatic permission that the Session has already adopted. Full departure ends the original contribution and its owned local reading binding, leaving a later manual binding intact. These intentions are durable before asynchronous cleanup. Receiving work runs outside the source mutation queue so a slow read or cleanup cannot prevent another Session from recording its stop. Restart cancels old pending work without authorizing a new Agent instance or starting a cold Agent. Automatic work requires a separate local decision.

## Alternatives considered

**Browser sequencing.** Consecutive request, bind, and resume calls cannot finish reliably after the page closes or identify a successful permission after a lost response. The Host owns recovery of the original participation.

**One lifecycle for contribution and reading.** Clearing the capture loses pending reading even when its independent grant remains valid. A bounded continuation retains only the work needed to settle the original operation, without a second permission authority or an unbounded join history.

**Reissuing identities or refreshing consent.** A new invitation, subscription, or read-state sequence can bypass a later cancellation or manual choice. Recovery uses the original identities and observed state.

**A reusable group code.** Multiple claimants need separate application identities and capacity semantics. The implemented entry selects one Session capture.

## Consequences

One transferred entry and one explicit owner approval connect reading and contribution while preserving their separate states. This reduces setup work; it does not prove model quality, cross-machine reachability, or a reduction in human coordination. Responsibility text routes context and does not restrict the authorized Root Task contents.

A pending continuation blocks replacement by a new capture until the original work settles. Once adopted reading no longer needs a source continuation, the independent reading panel owns subsequent departure. Local departure leaves the owned subscription; it does not claim that the owner has revoked the read grant. The Session log remains the authority for adopted context and supports both SDK projections.
