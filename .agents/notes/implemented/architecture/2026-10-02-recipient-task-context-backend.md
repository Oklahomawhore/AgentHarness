# Agent Note: Replaceable recipient Task context backends

Status: implemented

English | [中文](2026-10-02-recipient-task-context-backend.zh.md)

## Problem

The native Task consumer coupled context selection to one complete JSON renderer. Replacing selection required changing Session admission, and every participant received the same publications. An asynchronous provider also creates a binding race: a result computed during an earlier stay in a Task must not enter a later stay, even when both stays reuse the same binding id.

The [scope context proposal](../../proposed/architecture/2026-10-02-scope-context-backends.md) requires replaceable computation before automatic capture and delivery. The existing [Task model](2026-08-28-task-context-atoms-and-session-bindings.md) remains the authority for explicit publications, lineage, and independent Session bindings.

## Decision

The [Task context package](../../../../packages/collaboration/development-task-context/README.md) owns a `/backend` Service Definition, a `/text` Service Provider, and its request-time Consumer. The provider computes text and source coverage without changing Task state or Session history. The Loader mounts the provider and Consumer; the abstract Service Definition is not a second mounted provider. These roles share a package while they evolve together.

The text provider keeps original Task objectives, scopes, and whole publications. Generic file reports follow [complete Write checkpoints and whole-segment budgeting](../feature/2026-10-04-tool-report-checkpoints.md). It excludes publications authored by the recipient and selects other publications within the complete text byte limit. Source attribution distinguishes included publications, self-authored exclusions, and budget omissions. This is deterministic selection, not semantic relevance or fact reconciliation. The provider cannot claim that omitted material was adopted.

Each request captures the current Task revision and the latest durable `task-bound` event's node and sequence. That event identifies the binding interval. After an asynchronous computation, the Consumer rechecks the interval and provider lifetime. A binding change causes selection to restart within the same pre-step, preserving the admitted user-message batch. New append-only publications do not invalidate an otherwise usable result; the following request considers their newer revision.

The provider identity and processing revision, text budget, Task revision, and binding interval determine reuse. A changed provider or budget produces a new projection on a live request. An unchanged projection and replay use the exact logged text; past events are never reinterpreted through a new backend.

The first projection joins the pre-step message batch so the Agent loop can establish its protected system-message head before admitting context. Replacements of existing projections use durable surface operations. [Disconnection withdrawal](../bug-fix/2026-10-02-task-context-disconnect-withdrawal.md) preserves history while removing the plugin's old context from later requests.

The Session event that commits a projection is the adoption authority. Its Task acknowledgment is a derived receipt issued after admission. Failure is reported and retried from the existing projection without repeating computation or interrupting the model request. The Task executor validates an optional expected binding epoch inside its serialized operation, preventing an old receipt from acknowledging a later binding interval. Native projections always provide that epoch. A receipt identifies the delivered view revision, not proof that the model used every fact.

## Alternatives considered

**Leave rendering inside the Consumer.** This keeps semantic processing inseparable from lifecycle and makes every new backend repeat request attribution and binding checks.

**Reject a step when its binding changes.** The loop has already claimed the incoming messages. A rejection can discard the user's request; recomputation preserves it while excluding the abandoned result.

**Acknowledge before appending the first projection.** Later admission can fail or be cancelled, leaving a receipt without a Session record. Post-admission receipts preserve a single local adoption authority.

**Start with latent payload variants and separate packages for each role.** There is no compatible latent receiver in this increment, and the three roles have one current consumer. The text implementation establishes actual behavior without publishing unsupported representation variants.

## Consequences

The backend is replaceable without changing Task membership, network transport, or Session delivery. Text selection does not require another model call. Changed projections can invalidate the model request suffix; reuse avoids repeated selection and duplicate context events.

[Native contribution capture](../feature/2026-10-04-native-scope-contributions.md) and [semantic processing](2026-10-03-audited-semantic-context.md) use this backend separation. Passing backend and replay tests alone does not establish semantic fidelity, task improvement, or product maturity.
