# Agent Note: Independent scope contributions and current evidence

Status: implemented

English | [中文](2026-10-03-independent-scope-contributions.zh.md)

## Problem

An independent collaborator must contribute ordinary work without joining the owner's trusted Mesh, copying its Task, or manually publishing each update. A receiving invitation grants no file access or write authority. Lost replies, replaced capture permissions, and owner revocation must not duplicate evidence or revive an ended source.

## Decision

[Claude scope](../../../../packages/collaboration/claude-scope/README.md) records a local collection permit for one Session; its supported selections are defined by the [source-mode decision](2026-10-03-independent-tool-observations.md). Its path-free proposal identifies the contributor PeerId and a durable capture generation. The owner separately approves this proposal for one local Root Task, exact source permission, expiration, sample count, and sample byte bound. A distinct [scope-access contribution invitation](../../../../packages/collaboration/scope-access/README.md) activates the prepared capture only after online owner verification. Read subscriptions and contribution permits have independent lifetimes.

The [Task service](../../../../packages/collaboration/development-task/README.md) serializes authorization, admission, and terminal events in its durable queue. Authentication comes from transport; a publication retains the contributor PeerId instead of inventing a Mesh node or participant. The owner derives source attribution, and OpenAPI artifact identity when applicable, from the approved selector. Exact retries recover the original receipt; a changed body for an existing source is rejected. Receipts distinguish approval, sample, and terminal commits. The source retains its outbox or pending withdrawal until the matching owner receipt arrives.

Only an authorized Write or Edit lease captures the permitted source. A Hook retains its capture generation before waiting in the local queue. Replacing a permit cannot authorize an older queued Hook. Received context and generated projections are not capture sources. For OpenAPI sampling, an invalid or missing file produces explicit unavailable evidence rather than leaving older valid fields current.

Grant expiry, owner revocation, and contributor leave produce terminal Task events and withdraw current evidence. `currentContextView` reconciles owner expiry before returning current input; consumers also recheck after asynchronous projection. Persistence failure rejects current delivery, including cached text. A newly committed terminal event invalidates a captured projection; ordinary newer samples can wait for the next request. Non-owner Mesh replicas fail closed on active independent peer evidence because replication cannot establish current owner authorization. Frozen parent revisions remain historical records.

[Context backends](../../../../packages/collaboration/development-task-context/README.md) separate peer and Mesh source identities, reduce OpenAPI same-source revisions, preserve independent conflicts, and exclude terminated evidence within complete text budgets. Peer attribution establishes the authenticated reporter, not truth of the claimed file contents or tool execution. Reserved inbound and outbound contribution-end capacity prevents this scope service's ordinary reads and samples from consuming every end slot; unrelated transport users remain outside that guarantee.

## Alternatives considered

**Reuse Task checkout authority.** An independent user need not have a replicated Task, Mesh membership, or an owner-controlled Session. Separate capture and contribution grants preserve those independent responsibilities.

**Keep a second write-authority table in scope access.** A separately committed permission and Task publication could disagree after failure. Task events remain the single owner authority; scope access authenticates and bounds requests.

**Treat expiry timers as the correctness mechanism.** A failed timer cannot prove a durable withdrawal. Request-time checks prevent delivery until the owner commits expiry. The timer logs failure without a zero-delay retry loop; later operations or Task changes trigger another attempt.

**Accept cached independent evidence from a Mesh replica.** A replica cannot know an owner revocation that it has not received. Online scope reads supply that authority; historical inherited snapshots remain explicitly historical.

## Consequences

The independent workflow automatically contributes bounded source observations after ordinary authorized tool work and can drive the existing native receiving and finite activation mechanisms. Setup requires explicit local collection permission and owner approval. The [joint online entry](2026-10-03-online-contribution-approval.md) also accepts separate passive-reading consent; the manual path uses a distinct receiving invitation. [Source setup controls](2026-10-03-independent-contribution-controls.md) manage preparation, approval, and recovery. General semantic extraction and cross-machine discovery need their own product validation.

Committed Task generations and existing SQLite tables retain their identities. New peer publications have canonical serialization for context hashes and restore. Ending a grant removes current injected evidence; it cannot retract bytes already sent, erase historical requests, or prove that a model has forgotten them.

The client-safe Task DTO entry loads Cordis types before declaring its event extensions. A type-only empty export survives declaration emit and is erased from JavaScript; an empty type import does not preserve that ordering in declaration consumers. The NodeNext artifact check compiles a separate DTO-first consumer so broader service imports cannot hide missing Context extensions.
