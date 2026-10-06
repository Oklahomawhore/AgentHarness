---
description: "Receive independently authorized scope context in native Agent sessions, with explicit bounded idle turns and replayable exact text"
kind: "package-reference"
---
# Native Agent scope context

English | [中文](README.zh.md)

## Summary

Connect a live native Agent session to its owner-local Root Task, an independently authorized remote read scope, or both explicitly selected sources. Every admitted request checks current authorization and receives exact logged context; busy changes wait for a natural request boundary. Explicit automatic permission can start a limited number of idle turns for a local goal. Remote notifications contain no facts, and mounting the package alone starts no work.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this consumer in a `dsh` profile that already provides native Agents, Session projections, and [scope access](../scope-access/README.md). Remote bindings own fresh receiver subscriptions. A combined binding retains an explicitly selected current local Root Task assignment and adds one remote subscription. Local scheduling additionally requires the Task context consumer and backend. Delegated, forked, and cold Agents cannot bind.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-scope-agent-context'
  config:
    maxContextBytes: 8000
    maxLocalContextBytes: 4000
    coalesceMs: 50
    retryDelayMs: 1000
```

| Field | Default | Meaning |
|---|---|---|
| `maxContextBytes` | Required | Total UTF-8 bytes of all managed context messages including framing; at least 512 bytes. |
| `maxLocalContextBytes` | Required | Complete local projection ceiling while both sources are active; must leave room for remote framing and text. Local-only and remote-withdrawn reads use the remaining total allowance. |
| `coalesceMs` | Required | Delay that combines pending changes before an idle activation attempt. |
| `retryDelayMs` | Required | Delay before rechecking an unavailable owner; automatic permission remains paused. |

The [configuration catalog](../../../docs/config-catalog.md) owns accepted ranges. Each remote read offers its available text bytes after reserving consumer framing and other managed context. Scope access clamps this offer to both Hosts’ limits before the owner computes complete source groups. A Task whose required representation cannot fit becomes an explicit withdrawal; text is never cut through Unicode characters or silently truncated.

### Explicit binding and permission

The authenticated local `scopeAgentContext` Remote exposes `bind`, `bindLocal`, `pause`, `resume`, `leave`, `leaveLocalTask`, `updateRoute`, and `status`. It exposes no raw transport or wait endpoint. Host plugins can call the same service directly:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScopeInvitation } from '@deepseek-ai/dsh-scope-access/types'
import type {} from '@deepseek-ai/dsh-scope-agent-context'

declare const ctx: Context
declare const agentId: SessionId
declare const invitation: ScopeInvitation
const current = await ctx.scopeAgentContext.status({ agentId })
if (current.eligibility !== 'eligible') throw new Error('Session cannot receive a scope')
const bound = await ctx.scopeAgentContext.bind({
  agentId, invitation, automatic: null, expectedBindingId: current.state.binding?.id ?? null,
  ...(current.localTask === null ? {} : { localTask: current.localTask }),
})
if (bound.binding === null) throw new Error('Binding was not retained')
const expectedBindingId = bound.binding.id
await ctx.scopeAgentContext.resume({
  agentId, expectedBindingId,
  automatic: {
    goal: 'Implement the assigned client integration',
    activationLimit: 3,
    maxStepsPerTurn: 2,
    minIntervalMs: 1000,
  },
})
await ctx.scopeAgentContext.pause({ agentId, expectedBindingId })
```

`status` reads an already live Agent without creating or restoring it. It distinguishes eligible, delegated, forked, conflicting, and not-live Sessions. Its `state` and `activity` share the `asOfSeq` Session-log position. Existing Session control streams expose scheduling state through `scopeAgentContext` and text-free recorded activity through `scopeAgentEvidence`. Status restricts activity to the current eligible binding and local goal: the actual request retained by the current turn, the latest successful completion, and the latest evaluation. It clears activity when automatic permission or the eligible target is absent. Restored history remains history and does not renew permission; completion attests the recorded turn, not output quality. `localTask` identifies the current owner-local Task epoch. Local bindings have `subscriptionState: unbound`; remote `active` records local intent, not current owner authorization or model adoption.

Every management mutation compares `expectedBindingId` before changing state; bind accepts null only when no scheduling binding exists, including a Session with a local Task assignment. Delayed bind and resume also recheck the exact Agent instance and binding before committing. A replacement bind retains its prior binding until the new subscription is ready. An unadopted late subscription is ended. If an RPC reply is lost, read status before retrying: a committed binding remains queryable, and a stale conditional retry is rejected. Mutation responses have no Session watermark and must not overwrite a newer Client projection.

`updateRoute` compares the current binding and `readStateSeq` before changing an owner address. The address must use direct IP/TCP with a nonzero port and the same owner PeerId. The original grant, subscription, binding, automatic policy, and consumed budget remain unchanged; an active automatic turn is not cancelled. Route recovery neither proves reachability nor renews permission. An ended subscription cannot recover. Invalid addresses report `scope-agent/invalid-route`.

`bindLocal` requires the current Task ID, Task binding ID, binding epoch, and observed scheduling binding. It grants execution only; file capture remains independently authorized. `automatic: null` keeps passive Task reads. `leaveLocalTask` first stops owned automatic work, then conditionally clears the exact current Task epoch and its captures. A stale local scheduling binding can be discarded with `leave` only when no Task assignment remains.

`bind` and `adoptJoinRead` require `localTask` with the exact assignment epoch to retain existing local responsibility. The combined interval has one explicit automatic policy and one lifetime reservation count. Prior local automatic permission is retained separately and never authorizes remote triggers. Leaving the remote scope restores a new local interval with the prior policy paused, or passive when no policy existed; the Task, epoch, history, file permissions, and local captures remain. Local Task departure requires leaving the remote scope first.

Source-associated joint adoption records the original capture in a version-4 plan and binding. The owning Session retains it across read retries, stop of contribution, and route recovery; manual binding does not infer it from a read invitation. A later manual binding or departure cannot inherit the previous association. The owner verifies it before returning a version-3 capture projection; [scope access](../scope-access/README.md) owns that verification. This enables exact-source tool-report omission without granting execution permission or asserting that the model remembers the omitted content.

Combined admission runs through the Task consumer once. It computes the local projection under `maxLocalContextBytes`, subtracts its actual text and all framing and additional withdrawals from the total allowance, then requests a remote projection within the remainder. After that online read, it synchronously rechecks local assignment, provider, revision, and expiry. Changed local authority discards the candidate and repeats the read. It retains both exact messages under the total budget. Remote failure withdraws remote facts while ordinary user work receives fresh local context using the remaining total allowance; automatic continuation stops. Both projections and both committed message sequence numbers establish automatic request evidence, and changes to either source invalidate the completed comparison.

Management failures carry structured Remote codes, including `scope-agent/stale-binding`, `scope-agent/not-live`, and `scope-agent/terminal-subscription`; clients discriminate by code and details rather than diagnostic text. Known revoked, expired, left, or missing subscriptions cannot resume. Pause and leave remain available for the exact binding when a local Task assignment conflicts.

`automatic: null` permits passive request-time reads only. `activationLimit` is an absolute lifetime reservation limit for this Session, not an allowance added by each resume. Cancelled reservations remain consumed; leave, rebind, and restart retain `usedBudget`. Resuming an exhausted policy requires an explicitly larger absolute limit. The local goal supplies the automatic pulse; remote text cannot grant execution permission.

`pause` stops automatic scheduling and removes only this consumer’s queued pulses. Ordinary user requests can still receive current authorized context. `leave` ends remote receiving and its subscription; a combined binding retains local Task receiving with the prior automatic policy paused. Agent cancellation stops active running or maintenance work; while an idle network prefetch is outside an Agent activity, use `pause` to stop future automatic execution. A normal idle Agent cancel does not disable this policy.

An automatic goal establishes a comparison baseline only after its actual model request contains the exact logged scope snapshot and its whole turn completes successfully. Ordinary user requests, prefetches, queued pulses, failed requests, and cancelled turns do not establish this baseline. A new binding or changed local goal requires its own completed automatic turn.

The backend declares either exact projection comparison or recipient evidence comparison. A freshly authorized, complete recipient evidence match suppresses an idle activation without consuming a pulse or reservation, even when source provenance advances. Source authority, binding, goal, backend identity, and evidence remain part of the comparison. Ordinary requests still receive the latest exact text. An omitted current evidence group pauses automatic permission with `coverage`; adjust scope or capacity before explicitly resuming.

Automatic work also pauses when any backend reports a `budget` omission for a publication in the current Task revision. This check runs before reservation and again before each automatic model request, including tool continuations. A reservation already spent remains consumed. Self-published, superseded, and withdrawn omissions alone do not trigger this check; ordinary user requests retain the text backend’s bounded output and omission information.

An automatic tool continuation requires its original permission and current authorized context. Unavailable, ended, failed, or oversized reads end the automatic turn before another model request, even after its pulse has been consumed. A watcher pause also stops that continuation if reading recovers before the next step; connectivity does not resume permission. Newly claimed external input may continue as ordinary work, with current context or an explicit withdrawal. Spent reservations and completed tool results remain recorded.

Pause, leave, replacement binding, and consumer disposal cancel an active turn started by an owned automatic pulse. An already dispatched request can have produced effects; its work is not replayed automatically. Claimed user input not yet dispatched is returned to the Inbox once. A mixed turn already sent to the model is interrupted, while an independent ordinary user turn is not cancelled.

Restoring a live Session preserves binding and exact message history but pauses automatic permission. Pending pulses are removed without refunding reservations. Restoration does not recreate cold Agents, replay an activation, or recompute historical text; the next live request still performs an online read.

The Host-only joint-join methods reserve an exact read plan in the source Session before creating a subscription. `readStateSeq` compares reading management events; ordinary messages do not change it. An adoption ID retains its original invitation, comparison cursor, subscription and binding IDs, and optional explicit automatic policy. Omission keeps passive receiving. Automatic adoption records the binding and policy together and starts scheduling only after the Session checkpoint succeeds. The policy uses the existing lifetime reservation count, without resetting or extending it. A pending automatic plan belongs to the original live Agent and consumer instance; a replacement terminates it. Retry cannot replace later manual decisions, resume a paused binding, or reopen a cancelled operation.

The Session records and flushes a route intent before Access changes its receiver record. A failed Access write remains recoverable from that intent before the next read or watch; stale replies from the previous route are rejected. `updateJoinReadRoute` applies the same rule to the original joint adoption, including a cold stored Session without starting an Agent. The adoption plan stays immutable. A combined plan atomically pauses the original local policy and clears its pending pulse while retaining the original binding and policy; failed or cancelled plans leave that local policy paused until explicit resume. It stops its owned automatic activity; external adoption waits for that activity to retire before installation. Ordinary turns may adopt directly. An automatic turn cannot replace its own receiving permission; that call rejects to avoid waiting for itself. Explicit pause, rebind, or leave supersedes the pending plan. A fixed read-state comparison prevents a delayed recovery from overriding later manual reading controls, including an address that changed away and back.

`cancelJoinRead` records pending cancellation before waiting outside the management queue for any already-started subscription creation and ending that subscription. Stopping contribution preserves adopted reading and its automatic permission; complete departure withdraws only the binding owned by that operation. Cold cancellation exclusively opens the existing Session log without starting an Agent. A missing log, competing writer, invalid transition, or failed durability checkpoint rejects cancellation so the caller retains its pending intent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

An opaque authorized change cursor marks the binding dirty. Busy Agents receive no injected or steering message; their next natural pre-step reads current authority. An idle automatic binding coalesces changes, owns one prefetch at a time, reserves an activation inside a short `runMaintenance`, and queues a local goal pulse. Pre-step reads independently again, checking the exact Agent and binding after awaits. A newer notification does not starve an already captured read; it remains dirty for a following request.

Local Task changes, terminal notices, backend replacement, and the nearest source expiry invalidate the same scheduler. Ordinary owner-local tool observations published by the receiving Agent on its local Task do not independently wake it; explicit publications and terminal notices still do. The actual Task admission consumer owns one injection point. Its unload aborts owned automatic work; a replacement consumer cannot inherit automatic permission. Unassociated local state and request evidence use version 2; combined bindings and dual-input evidence use version 3. Capture-associated state, adoption, evaluation, and request evidence use version 4; source snapshots and route intents use version 2. Prior event versions retain their strict parsers and cannot accept newly associated projections.

Whole-state Session events own binding and cumulative reservations. Exact context messages carry subscription, binding, grant, peer, task revision, backend identity, projection identity, and source coverage. The first message enters through normal Loop admission after the protected system head. Later projections replace owned visible nodes while preserving historical events. Terminal or unavailable reads withdraw current context; they never authorize an automatic turn.

| Source | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Local management, bounded wait and activation ownership, and request admission. |
| [state.ts](src/state.ts), [types.ts](src/types.ts) | Strict replay validation and complete Session scheduling state. |
| [messages.ts](src/messages.ts) | Exact context text and durable replacement. |
| [evidence.ts](src/evidence.ts) | Logged scheduling decisions, actual request evidence, and completed automatic-goal comparisons. |

No invariant companion is published because the Session projection folds authoritative events and each admission checks the current binding and complete byte budget. Scope access owns remote authorization; AgentLoop owns request and activity ordering.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Scope access](../scope-access/README.md) — independent read grants and change hints.
- [Agent loop](../../core/agent-loop/README.md) — native activity, cancellation, and admission.
- [Session projection](../../session/session-projection/README.md) — replayable state folds.
- [Task context](../development-task-context/README.md) — context for local Task assignments.

-----

<a id="model-experience"></a>
## Model Experience

### Shared scope snapshots and local goals

#### What the model sees

Remote bindings receive a user-role `## Shared scope context` message. Local bindings receive the Task backend text through the Task consumer’s version-3 snapshot; the scheduler does not add a second context node. A local automatic pulse asks the model to continue the explicitly authorized goal using the current snapshot. `## Shared scope context withdrawn` states that earlier snapshots cannot establish current facts. No recall tool or per-publication send action is required.

#### Token effect

Conditional. One current context message per selected source is retained, and automatic turns add a bounded local goal pulse. Reusing the same authorized projection adds no context message. A complete evidence match can suppress an automatic turn; it does not remove source history or prove a token saving for other workloads. A withdrawal is a short replacement, not a semantic summary of removed text.

#### KV Cache effect

Replacing a visible context node invalidates the request suffix from that node onward. An unchanged authorized projection preserves that node. Historical Session events remain available for replay.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Native Sessions only** — this consumer cannot wake arbitrary Claude Code terminal sessions. It does not start cold Agents or bind delegated/forked Agents.
- **Read-only scope** — a Root Task grant and responsibility do not confer file, command, capture, or cross-owner write permission.
- **Local scope** — only an exact owner-local Root Task assignment is eligible. Filtering its own ordinary captures does not prove freedom from cross-owner semantic feedback loops.
- **Provider-defined comparison** — the facts backend compares supported declaration evidence selected for the recipient. The semantic backend compares exact selected summaries and their source evidence; Text providers use exact projection identity. Arbitrary paraphrases are not proved equivalent, and a semantic relevance mistake can suppress a useful response. Online reads and audit records continue even when an automatic turn is suppressed.
- **Visible replacement is bounded** — removing an owned context node does not erase facts quoted in ordinary user or assistant messages, undo work, or prove model forgetting.
- **Explicit resume** — unavailable authority, failed waits, cancellation, step limits, and budget exhaustion pause automatic permission. Recovery can continue passive reads; automatic turns need explicit resume.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Cancellation during the short maintenance reservation removes only owned pulses synchronously. Abort listeners remain installed until the returned maintenance promise settles. Plugin disposal aborts and drains owned reads and waits; mixed user input remains available when automatic permission is rejected.

</details>
