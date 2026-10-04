# Agent Note: Sampled API declarations in recipient context

Status: implemented

English | [中文](2026-10-03-sampled-api-context.zh.md)

## Problem

A successful tool observation does not establish the file's current declarations, their relationship to earlier evidence, or their relevance to another participant. Plain publication text cannot prove that the Host sampled an authorized artifact. Retrying a read after storage failure can associate new bytes with an earlier operation; clearing collection permission alone leaves prior declarations active in recipient context.

## Decision

The [Claude adapter](../../../../packages/collaboration/claude-scope/README.md) accepts separate exact-file read grants for supported OpenAPI operations. Tool roots alone grant no file access. The configured source name and operation identify a logical API within a Task; each collection grant has its own observation sequence. Different paths do not automatically identify the same API, and different grants do not establish a shared causal order.

A matching leased Write/Edit completion samples the authorized file, including reported failures. The reader hashes and parses the same bounded bytes, checks path and handle identity, and extracts a restricted OpenAPI 3.1 declaration subset. Unsupported input, read failure, and replacement produce explicit evidence states without retaining partial facts. The record describes sampled declarations, not deployment, complete validation, or proof that the triggering tool wrote those bytes. Same-user hostile filesystem races remain outside the portable path-check threat model.

The serialized adapter stores extracted evidence before [Task admission](2026-10-02-observed-task-context-admission.md). Pending admission reuses that exact evidence after retry or restart. Task admission stamps observer identity and binding attribution, compares full metadata during source deduplication, and enforces increasing new sequence numbers within a grant. Ordinary Remote publication cannot supply trusted observation metadata. Optional versioned metadata preserves existing unannotated records and inherited-block hashes.

Host-only retirement proves a previously admitted chain instead of requiring its binding to remain active. This permits recovery after external binding clearance without accepting late ordinary observations. The adapter removes collection permission, durably prepares retirement, and completes retirement before clearing the binding and reporting leave success. Failure retains enough state to retry. Task event limits reserve one retirement event per live chain; restoration rejects a local configuration that cannot honor those reserves.

The [facts provider](../../../../packages/collaboration/development-task-context/README.md) reduces complete observation chains before selecting recipient fields. Invalid, unavailable, and revoked heads never restore older valid declarations. Each chain projects current records, at most one predecessor reference, and the total superseded count; older sources are explicitly omitted as superseded, so their history cannot exhaust the current-fact budget. Independent disagreements remain unresolved; a conflict group retains complete competing fields and attribution even when normal responsibility routing omits those fields. Routing is not permission. Budgeting includes the complete group and framing, and excludes a whole group when it cannot fit. Inherited publications remain frozen historical evidence rather than current declarations.

Exact responsibility labels select explicitly configured fields. Configuration contributes to the provider revision. Native Session logs and external prepared-output records retain exact projection text; neither replay recomputes facts from later files. The existing text provider remains available for original publications.

## Alternatives considered

**Interpret arbitrary publication JSON as sampled facts.** A parseable payload or observation-like id proves neither file access nor source authority. Only the Host admission method can attach the typed metadata.

**Select the last arriving claim.** Independent grants have no shared sampling order. Choosing by arrival hides uncertainty; within one grant, durable sequence records observed order without claiming write causality.

**Withdraw only while the original binding is current.** An external clear or restart can precede retirement. A separately proven retirement operation preserves the strict epoch checks for ordinary capture.

## Consequences

Ordinary authorized file work can update recipient declarations without per-change publish or recall. The subset and explicit source mapping are limited: arbitrary semantic extraction, unattended file watching, cross-owner authorization, idle wakeup, and real-model adoption remain separate requirements in the [product proposal](../../proposed/architecture/2026-10-02-scope-context-backends.md). Complete local delivery is not evidence that an external model used the declarations.

Verification covers real temporary file changes, source spoofing, reordered retries, durable pending admission, invalidation, interrupted retirement, capacity reserves, conflict budgets, actual command profiles, and native request replay. Controlled native replay fixtures establish request and log behavior; adapter integration separately establishes production sampling.
