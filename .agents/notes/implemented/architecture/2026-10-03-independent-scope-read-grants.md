# Agent Note: Independent recipient-pinned scope read grants

Status: implemented

English | [中文](2026-10-03-independent-scope-read-grants.zh.md)

## Problem

A collaborator needs another owner's current work context without gaining access to that owner's other Tasks, Room membership, assignment log, or private conversations. A cluster-wide shared credential and full Task replication cannot express this permission. A read invitation must also remain separate from permission to collect the recipient's files or publish observations.

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.md) provides per-recipient read grants over independently authenticated [scope transport](../../../../packages/collaboration/scope-transport/README.md). The owner issues a durable invitation for one local Root Task, one recipient peer, a non-reusable grant generation, responsibility, and expiration. The receiver stores a separate subscription identity and generation. Joining records local intent; each retrieval independently establishes online authorization. No Task assignment epoch or native Session is fabricated.

The peer protocol exposes only invitation-bound reads. It authenticates the sender before looking up Task contents and returns a uniform metadata-free refusal for a mismatched grant, peer, or invitation. It does not expose Task lists, Rooms, lineage, or replica logs. Root-only admission excludes inherited context; Fork and Merge authorization requires a separate decision. Responsibility controls backend routing, while the read grant authorizes the entire selected Task.

The owner invokes the existing context backend outside the mutation queue. It then verifies current grant state, expiry, Task ownership, Root origin, provider identity, and cancellation before persisting exact output and returning it. Revocation updates the existing record and does not wait for slow computation. A captured source revision remains usable when newer publications arrive; subsequent retrieval captures the new revision. This permits delivery during continuous activity without presenting arrival order as truth.

Every request has a fresh correlation identity. The receiver rejects mismatched Task, peer, grant, generation, reply identity, projection digest, source attribution, and byte budgets before persistence. A newer request or local leave invalidates delayed adoption. Both Hosts retain exact projection text and coverage; strict durable parsing and local peer pinning prevent key replacement from silently inheriting stored authority. Identical projection bytes reuse a record; distinct records and terminal identities remain bounded by explicit retention limits.

An unavailable owner means authorization is unknown. The receiver returns no cached projection in this state. Revocation and expiry are separate terminal outcomes. The owner decision linearizes after durable authorization checks; bytes already sent cannot be recalled. Consumer framing, logged model input, and the external host's actual model admission remain consumer responsibilities.

## Alternatives considered

**Reuse trusted Mesh replication.** Shared cluster credentials and global replication disclose more than the invited Task. The independent read protocol carries only authorized projection text and coverage, while observed-write intervals remain a separate authorization system.

**Let the recipient compute from a downloaded Task.** This would disclose source material omitted by the owner's projection and require broader replica permissions. Owner-side computation keeps source selection and authorization together without transferring a fabricated partial Task snapshot.

**Authorize cached context while offline.** An offline lease would delay revocation and require a separate expiry and clock policy. Rechecking on each request gives a smaller promise: offline context is unavailable, not implicitly current or revoked.

**Wait for a revision that stops changing.** Requiring the Task revision to remain unchanged throughout computation can starve delivery during ongoing work. Explicit captured revisions preserve attribution; authorization and provider identity are still checked at adoption.

## Consequences

Read access is independent of capture permission and grants no publication rights. The trade-off is an online owner dependency and finite exact-output retention. Expired and revoked records remain tombstones, so capacity changes cannot silently revive old invitations. A receiving consumer must stop presenting earlier facts as currently authorized when retrieval is unavailable or inactive.

The package tests exercise exact persistence, private-scope refusal, mismatched wire attribution, revocation during computation, local leave, provider replacement, continuous publications, disposal, bounded concurrent reads, storage failure, expiry, restart, and key replacement. The independent-process fixture owns actual authenticated transport and external consumer evidence; unit results alone do not establish cross-machine reachability or model adoption. NAT traversal, idle wakeup, and cross-owner write authorization remain outside this decision.
