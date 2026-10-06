# Agent Note: Scope creators contribute through explicit local capture authority

Status: implemented

English | [中文](2026-10-04-owner-local-scope-contributions.zh.md)

## Problem

An independently owned peer can contribute to a Root Task and receive its context. The Task creator's own native Agent also needs to participate. A local Task assignment supplies receiving context but does not authorize collecting files. Sending a peer invitation to the same Host would confuse local Agent permission with transport authentication, and ordinary context publications have no capture-wide withdrawal.

## Decision

The [Task service](../../../../packages/collaboration/development-task/README.md) owns a distinct local contribution interval. Host-only admission binds the Root Task, local Agent participant, exact assignment epoch, capture generation, permitted tools, expiry, and sample limits. Open, sample, and end records use the Task's serialized persistence and original receipts. An ended capture cannot reopen with changed limits. Terminal evidence remains after the Agent disconnects, while current projections exclude its earlier reports.

The [native source consumer](../../../../packages/collaboration/scope-agent-contribution/README.md) accepts local consent through `requestLocal` and exposes the current assignment through `localStatus`. Local and independent-peer modes share actual file-tool observation, Session attribution, bounded completion retention, and source limits. Local records use a separate storage domain; existing remote records retain their representation. [Independent capture destinations](2026-10-06-independent-native-capture-destinations.md) permit one Session to retain both separately authorized captures. Stop, changed assignment, and individual Agent disposal terminate the old local authority. Restart ends a restored capture without granting a new live instance permission.

The owner continues receiving through the existing [Task context consumer](../../../../packages/collaboration/development-task-context/README.md). The backend excludes the owner's own reports by publisher identity. Text, facts, and semantic providers recognize the local terminal interval; read permission survives source termination. [Scope access](../../../../packages/collaboration/scope-access/README.md) also checks terminal revisions after a slow backend computation and after projection persistence, so late results cannot restore an ended source.

Backend identities remain unchanged because previously valid inputs retain identical processing. Local publication records were rejected by the previous strict Task schema and could not have produced a valid persisted projection. This compatibility argument does not apply to changes to common prompts, existing input rendering, or existing selection semantics.

## Alternatives considered

**Permit self-peer invitations.** Peer identity identifies a Host, not permission to collect from one of its Agents. A separate local authority retains source selection and Task binding checks without inventing a network round trip.

**Use ordinary local publications.** They cannot end all reports from one capture after stop, expiry, or restart. A durable interval makes withdrawal independent of a still-live Agent or assignment.

**Create another tool observer.** Separate observers would diverge on filesystem providers, PTC attribution, durable completion, and failed operations. The consumer shares these mechanics and changes the admission authority.

**Combine all joining permissions in this change.** Read, outgoing file collection, and idle execution have distinct effects. The creator can participate using the existing local read path while invitation simplification and local idle scheduling receive their own acceptance evidence.

## Consequences

Two Hosts can use their existing native Agents as owner and peer sources. Local context is adopted during natural requests; [local automatic work](2026-10-04-local-task-automatic-work.md) owns separately authorized idle activation. It does not establish cross-machine setup, real-model semantic quality, or task outcome improvement. Reports retain tool provenance and may include local participant and binding identifiers, but permitted filesystem roots stay local. Historical bytes and already completed actions cannot be recalled.

The [native source decision](2026-10-04-native-scope-contributions.md) continues to own collection and durability tradeoffs. Separate local storage preserves remote records; running an older build does not provide management or downgrade support for new local permissions. Only durable source records survive process loss. Unloading the source plugin stops collection but cannot guarantee an immediate durable Task withdrawal when storage is also closing. It preserves the original capture and outbox for restart to finish termination; expiry also ends authority. Use Stop before unloading when immediate withdrawal is required.
