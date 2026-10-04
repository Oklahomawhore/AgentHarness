# Agent Note: Binding-scoped observed Task context admission

Status: implemented

English | [中文](2026-10-02-observed-task-context-admission.zh.md)

## Problem

An observation can arrive after its Agent switches Tasks, and a sender can retry after losing a successful response. Choosing the current Task at completion misattributes the observation. Treating every retry as a publication creates duplicate context and revisions; keeping deduplication only in adapter memory loses that protection on restart.

## Decision

The [Task service](../../../../packages/collaboration/development-task/README.md#observed-context-admission) provides a typed Host method, `admitObservedContext`. The caller supplies a filtered observation, its original binding interval, and a lowercase SHA-256 source digest that includes that interval. The digest is a stable identity, not proof of authorization. Capture grants, tool-input checks, and source identity construction belong to the calling adapter. The method has no Remote endpoint.

The existing Task executor serializes ownership checks, current participant and binding checks, epoch validation, deduplication, and publication. It accepts only locally owned Tasks and local Agent participants. Presence expiry alone does not revoke a durable binding. A mismatched or cleared interval fails before looking up a prior publication, including an A-to-B-to-A transition. Cross-node admission uses the separate owner-approved interval operations described below; this local method rejects that route.

Each source maps to `context-observation-<sourceId>` in the publication id. The publication text uses the same trim and byte-limit rules as explicit context. An existing id with the same effective text, publisher, and optional observation metadata returns its original publication and the current Task; conflicting content is rejected. Reuse changes neither the publication timestamp nor the Task revision. New observations use the persist-before-append path and retention bounds. A persistence failure leaves no accepted source to suppress the next attempt.

The committed `context-published` event is the sole deduplication record. Restoring the Task and assignment logs restores retry handling. Optional typed observation metadata resides on the publication; Task admission requires no separate deduplication table or Session event. Distinct source ids preserve distinct observations even when the rendered text matches.

The [sampled API context decision](2026-10-03-sampled-api-context.md) defines typed artifact evidence, source sequencing, and separate Host-only retirement. Retirement proves a previously admitted chain; it does not relax the current-binding checks in `admitObservedContext`.

## Remote owner intervals

A Task owner explicitly approves the source node, participant, binding id, and exact binding epoch. A replicated assignment is a discovery candidate, not capture permission. The source adapter separately owns local collection consent. Mesh commands use the dispatcher’s peer identity rather than a caller-supplied observer. This authorization operates inside the trusted Mesh: shared-secret peers and full Task replication do not provide independently authenticated owners or private Task readership.

Approval, admission, and termination commit to the owner’s Task log. Admission preserves the source observer while the event identifies the committing owner. A receipt identifies its original event and Task revision; later Task revisions do not alter it. The remote response carries only this publication and receipt, so unrelated Task history cannot make a successful admission too large to acknowledge. An identical already-admitted request can recover that receipt after termination, but cannot add or reactivate context. New sources require an active interval. The source persists the exact pending request before delivery and retains it until a validated durable receipt arrives; absence from its local replica proves neither rejection nor nonpublication. Fresh and retained receipts must match the original Task, owner, source digest, binding interval, and publication identity; fresh replies must also contain the exact admitted publication before the adapter acknowledges its outbox.

Termination persists the full interval identity even before approval. This tombstone prevents a delayed approval or new observation from reopening the binding. One terminal event derives deterministic artifact withdrawals and a source-ended notice. Each active interval reserves that event’s capacity; an unknown interval’s termination can fail at capacity, requiring the source to retain its pending end. Current backends exclude observations from ended intervals and retain coverage for omitted sources; old publications remain immutable history.

The adapter stops local capture, clears its binding, and retains one pending remote termination per session. It refuses another join or grant update until the owner confirms that termination. This sacrifices offline scope switching to avoid treating an unconfirmed remote state as closed. Restart, connection and Task events, hooks, session reads, and explicit retry can resume delivery. Prepared recipient output and owner receipts establish transport and persistence, not model adoption.

## Alternatives considered

**Deduplicate in the adapter.** A separate success marker cannot atomically track the Task commit. A crash between them can either duplicate a publication or suppress one that never committed.

**Look up duplicates before validating the binding.** This lets retries from an abandoned interval bypass current admission rules. The original publication stays in history, but a successful retry still requires a current authorized interval.

**Treat a remote assignment as permission.** Membership alone does not authorize work observation. An exact owner approval and the source’s local grant have distinct owners.

**Discard pending observations when absent from the source replica.** The owner can commit while its reply and replication are both lost. Only a validated owner receipt resolves that uncertainty.

**Terminate only approved intervals.** A leave that wins a race with approval would otherwise leave no durable prohibition against the delayed approval.

## Consequences

Concurrent retries and restart replay return one original publication. The package-owned expected output records the stable admission result; focused tests also cover conflicting content and publishers, queued rebinding, disconnection, invalid sources, payload and retention limits, and persistence failure.

This method is a prerequisite for automatic capture. It does not install hooks, observe an external Agent, produce a model request, or establish model receipt. Native and external-client adoption require separate end-to-end verification when their adapters consume this API.
