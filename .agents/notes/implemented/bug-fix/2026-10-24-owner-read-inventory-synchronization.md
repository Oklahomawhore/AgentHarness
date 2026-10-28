# Agent Note: Owner controls share durable read-authorization notifications

Status: implemented

English | [中文](2026-10-24-owner-read-inventory-synchronization.zh.md)

## Problem

Member cards and independent reading controls describe the same read permission through different inventories. Refreshing only the initiating panel can hide the revocation control after approval or retain an active member label after revocation. A local callback cannot observe another browser's operation or a recovered approval that commits its read grant later.

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.md) emits its existing authorization-change notification after a read grant is durably created or revoked, including reconciliation of a retained joint approval. A failed write and an unchanged authorization emit no new notification. Notification is an invalidation signal; authenticated queries remain authoritative.

The [Client plugin](../../../../packages/client/ui-emergence-center/README.md) owns independent reading inventory through the existing contribution directory. The same Host notification invalidates both this inventory and the affected Task's member inventory. Framework-generated hooks deliver confirmed data to components; form inputs and transient presentation remain local. Directory generations reject stale responses, mutations retain their pending state across panel dismissal, and connection reset reads a fresh baseline.

The directory retains uncertain mutation outcomes separately from failed status reads. Automatic read recovery clears its read error while retaining a lost mutation warning, including through a failed confirmation read; an explicit reread or a subsequent mutation clears that warning.

Task acknowledgements update Task progress without refreshing every previously viewed Native local permission. Only binding and clearing change its assignment identity. Those events invalidate the matching participant and unresolved identities, while confirmed unrelated Sessions keep their observations.

## Alternatives considered

**Refresh the sibling panel after a local click.** This misses other browsers and retained approval reconciliation. It also makes one component responsible for another component's authority reads.

**Pass a member-inventory revision to trigger another component fetch.** This retains two owners for asynchronous read state and couples reading inventory to the display lifecycle of member cards.

**Poll the inventories.** Polling adds recurring reads and still leaves a stale interval. Existing committed authorization notifications identify when these inventories need reconciliation.

## Consequences

Reading and contribution retain independent permissions while their displays update together. Failed inventory confirmation retains the last observation and disables mutations; retry reads authority without repeating a prior mutation. Claude receiving changes refresh the Session directory before waiting for inventory confirmation. Notifications are not replayed, so reconnect still requires a fresh read; a displayed state is not proof of context delivery or current peer connectivity.

The same-page tests mount the production plugin, slot renderer and both controls. They cover approval, independent and other-browser revocation, and Session refresh when inventory confirmation fails. Host tests establish notification timing at durable writes, including recovered joint grants. These observations do not change or replace Host permission enforcement.
