# Agent Note: Shared scope entries retain independent member authority

Status: implemented

English | [中文](2026-10-07-reusable-scope-group-entry.zh.md)

## Problem

Several people can share a goal while retaining their own Agents, Tasks and permissions. A single-capture application identity cannot also identify a reusable entrance: another applicant would either be rejected or overwrite the first person's consent and authorization. Treating every shared entrance as one grant also makes a person's departure affect unrelated participants.

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.md) distinguishes a reusable group entry from each authenticated applicant. Each application retains its exact peer, capture generation, source selection, consent limits and independent owner-assigned identity. Owner approval and rejection select that identity together with the original entry and proposal. A retry returns the retained decision; cancelling an application before its delayed submission retains its own terminal intent. Within one Task, an authenticated capture generation can be claimed by only one application entry. An unapproved application cannot terminate an independently issued contribution. Explicit approval can adopt that contribution only after retaining its exact grant.

An entry offers one owned Root Task. Its owner approves each member's contribution and reading separately from the member's local capture and automatic-response consent. [Joint receiving](2026-10-07-retain-local-task-during-joint-receiving.md) preserves each participant's existing Task, history and local authority. The shared goal does not create subordinate Agents or let the owner choose another person's execution goal or allowance.

One durable group record holds its entrance and retained members so admission and capacity commit together. A separate versioned storage domain preserves the single-capture record parser. Group application requests use their own protocol version; old entries keep their single-capture interpretation. Both domains retain the same transport-key ownership and participate in total application, planned read-grant and restoration checks. Whole-record byte limits reserve terminal transitions. Terminal applicants continue to consume their entrance's retained capacity and the Host's total application capacity.

Closing an entrance is irreversible and only prevents new applications. Existing pending applications can still be approved before the original deadline; approved grants keep their independent expiry and revocation controls. Application cancellation or owner rejection ends only that member's planned contribution and reading. Local joint departure instead ends its contribution and receiving subscription; it does not revoke the owner-issued read grant. Recovering an address changes neither membership nor deadlines. A probe is a momentary observation and cannot reserve capacity or authorize collection.

The native join flow accepts reusable entries with explicit local reading and collection consent. The Claude contribution adapter rejects this entry kind because it does not provide native joint receiving. Owner controls list entrances and individual applications with separate cursors, show the public capture identity for distinct Sessions on the same peer, and distinguish closing new applications from revoking a member. A member whose contribution has ended can still be ended while its reading permission remains active. The chat view hides background information exchange; logged request context remains reconstructable.

## Alternatives considered

**Reuse the single-capture entry as a group.** Existing entry possession and durable decisions name one capture. Widening them would change their meaning and risk assigning one person's grants or cancellation to another.

**Store capacity and applications in independent rows.** A capacity claim and its member record would need a cross-row transaction or recoverable reservation protocol. The bounded whole-entry record commits them together at the cost of a finite entrance size.

**Release capacity when an applicant leaves.** Retained terminal intent prevents delayed requests from resurrecting an application. Recycling the slot while keeping those intents would let retained storage grow beyond the advertised limit.

**Close every grant when the entrance closes.** Owners need to stop distributing new access without interrupting admitted participants. Per-member revocation remains the operation that removes existing authority.

## Consequences

People can use one entry to connect independently owned Agents, while normal authorized file work supplies facts to the shared scope. Three-participant SDK and browser scenarios exercise cross-person updates, correction, optional finite responses, passive receiving and independent departure. Protocol checks cover competing claims, exact selections, restart and retained limits. Controlled responses establish request delivery and reconstruction, not real-model collaboration quality.

The owner still hosts the shared Task authority; this is not ownerless peer federation. Direct network reachability is required. Joining does not backfill existing private history or files, and remote projections can include the recipient's own reports because peer captures do not share the local participant identity used for self-publication filtering. [The user guide](../../../../docs/user/guide/collaboration-network.md) owns the supported entry path and network limits.
