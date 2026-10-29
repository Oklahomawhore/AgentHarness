# Agent Note: Client inventories share the snapshot store and retain their lifecycle owners

Status: implemented

English | [中文](2026-10-25-client-inventory-snapshot-store.zh.md)

## Problem

Workbench, participant, Task, and MCP-client inventories need stable snapshots and renderer subscriptions. Their Host reads, mutations, connection resets, and presence leases have different owners. Reimplementing observer dispatch inside each directory makes rendering failures affect asynchronous refresh settlement and duplicates state publication.

## Decision

The [workbench inventory](../../../../packages/client/ui-dev-workbench/README.md) and three [collaboration directories](../../../../packages/client/ui-emergence-center/README.md) use the existing synchronous [Client snapshot store](../../../../packages/client/store/README.md). Subscriber exceptions are reported without interrupting other subscribers. Repeated registrations of the same callback own independent unsubscribe functions. Wholesale publication deep-freezes draftable values outside production; the initial value is not implicitly frozen.

The renderer owns subscription cleanup. Consumers read nested DTOs without mutation, and Task graph layout creates separate node and position objects. Refresh ordering, stale-response generations, mutations, and participant lease disposal remain directory-owned. Participant refresh reports failures from both listing and announcement and releases its read lock after settlement. Lease replies must still belong to the current connection generation and selected profile. Closing stops new work and drains sent lease requests before attempting withdrawal. Timers are installed before notifying observers, so a synchronous reset or disposal cancels the scheduled renewal.

Task catalog and lineage queries use the Host's configured result defaults; the browser does not copy a second set of limits. The directory retains the selected Task across catalog refresh and connection reset, reads its lineage again, and preserves selected graph entries outside the bounded catalog. A separate request ordinal rejects older focus replies within one connection, including failures; the connection generation still rejects replies from a replaced Host connection. Task upserts compare revisions, so a lineage reply cannot overwrite newer notification data. Catalog reads merge only Task references added or replaced since the read began, preserving newer observations without retaining every row omitted by a bounded catalog. Assignment reads retain their starting array identity; participant list, announcement and heartbeat reads retain their starting snapshot identity. Superseded results cannot restore cleared bindings or withdrawn participants. The existing read lock admits one fresh baseline after supersession; accepted publications advance their captured identity so a successful read does not invalidate itself. Lease success and scheduling remain independent of roster publication.

[Read-authorization invalidation](../bug-fix/2026-10-24-owner-read-inventory-synchronization.md) retains its independent notification and permission decisions; the inventory engine does not replace Host authority or the contribution directory.

## Alternatives considered

**Keep a listener set in each inventory.** Observer errors then escape through refresh promises, and callback registration ownership differs from the renderer's existing store engine. The shared engine owns these publication semantics without owning Host work.

**One generic refresh or lifecycle controller.** Workbench reads start explicitly, MCP setup replaces individual clients, participant reads can announce and renew a lease, and Task reads join catalogs with assignments and bounded lineage. A shared controller needs policy callbacks and obscures these existing owners.

## Consequences

Subscriber exceptions do not reject refreshes, and each renderer registration can be removed independently. Readonly DTO use is required when development publication freezes nested arrays and plain objects. Directory tests cover reset generations, errors, mutations, lease release, and subscription cleanup; assembled UI tests cover actual renderer updates and disposal. No generic controller, new Host authority, durable event, or model input is introduced.
