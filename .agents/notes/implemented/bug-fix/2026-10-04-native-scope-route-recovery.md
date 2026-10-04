# Agent Note: Native route recovery preserves existing participation

Status: implemented

English | [中文](2026-10-04-native-scope-route-recovery.zh.md)

## Problem

A Task owner can retain its device key and stored grants while changing its listening address. Native participants retain the original route in their contribution application and read subscription. Repeating admission can reset local execution permission, while requiring a live Agent or valid application expiry prevents cleanup of an old contribution.

## Decision

The [native contributor](../../../../packages/collaboration/scope-agent-contribution/README.md) accepts an explicit route update for the original capture or remaining receiving continuation. The full application entry stays fixed except for the owner address. The observed route revision and address select the command; a retained last-command record distinguishes an exact lost-reply retry from a later change. Returning to an earlier address does not make an older command current. Recovery preserves roots, tools, limits, sample identities, and cancellation intent. Cold or expired operations can finish withdrawal without creating a new Agent or granting collection permission. A later Stop or Leave invalidates an older queued route change before it can replace the stopping signal.

The [native reader](../../../../packages/collaboration/scope-agent-context/README.md) records a route-only Session event before updating its existing subscription. The event preserves the binding, grant, adoption, automatic policy, and cumulative budget. Reads and watches reconcile that durable intent before using a route. Monotonic subscription revisions reject delayed earlier routes, including when addresses cycle. Terminal subscriptions remain terminal. The read-state comparison prevents a delayed joint recovery from overriding a later local management decision. If contribution already uses the new address, the user can confirm that same entry again against the latest reading state without resuming paused work.

[Scope access](../../../../packages/collaboration/scope-access/README.md) compares immutable grant fields separately from the destination address. Recovery accepts only a direct IP/TCP address pinned to the original owner PeerId; the transport still authenticates the peer on connection. Address syntax alone does not prove reachability. Joint recovery carries a fixed read-state comparison, and contribution and reading retain separate outcomes. Ending contribution cannot implicitly leave an already adopted read subscription.

## Alternatives considered

**Repeat admission.** Creating another grant or binding loses the identity needed to settle uncertain requests and can reset local automatic permission. Recovery changes the original operation's route.

**Compare addresses alone.** An owner can move from one address to another and back. A delayed command can then match an obsolete address. Monotonic route revisions retain ordering independently of address text.

**Update storage before the Session.** A reader could contact a new route without a durable Session record. The Session intent commits first, and its original subscription update is retryable.

## Consequences

Users explicitly select a new route after an owner address change. Captured work and pending withdrawal can proceed under the same authority. Saving a route does not establish delivery, model adoption, or renewed permission. Loss of the owner's original identity or authorization storage requires separate recovery; this operation cannot reconstruct it.

Verification covers lost responses, route ordering, later local choices, terminal cleanup, durable Session replay, and actual request contents. Controlled model adapters verify transport and context behavior; they do not establish real-model quality or two-device usability.
