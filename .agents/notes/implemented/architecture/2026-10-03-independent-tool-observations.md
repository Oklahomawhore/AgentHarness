# Agent Note: Independent tool observations share bounded work events

Status: implemented

English | [中文](2026-10-03-independent-tool-observations.zh.md)

## Problem

Collaborators work across code and documentation files that cannot all be registered as OpenAPI artifacts. Requiring manual publication or one file selector per update prevents ordinary work from contributing automatically. Broadening capture must preserve local consent, independent owner authority, exact retry identity, and withdrawal without representing a tool report as verified current state.

## Decision

The [existing independent contribution lifecycle](2026-10-03-independent-scope-contributions.md) accepts a second source permission: a named Write/Edit tool set. The source user selects local roots and permitted tools once. The owner approves the same source and bounded consent through the [single-entry application](2026-10-03-online-contribution-approval.md) or explicit invitation. Entry, proposal, invitation, sample, and durable parsers enforce the source mode. Receiving remains separately authorized; the source receives no Task replica or Room membership.

The [Claude adapter](../../../../packages/collaboration/claude-scope/README.md) captures only matching authorized tool leases. A structured report contains reported success or failure, a root index, relative path, tool fields, and explicit whole-field omissions. Write carries content; Edit carries old/new text and normalized replace-all intent. A failed operation omits attempted success text. Completion rechecks local permission and retained input identity before persisting the exact sample. Neither arbitrary Bash output, transcripts, directory scanning, nor additional file reads are authorized by this mode.

The [Task owner](../../../../packages/collaboration/development-task/README.md) validates the source/tool association and complete request budget, derives attribution and canonical text, and retains each event under its advancing sequence. The structured metadata excludes absolute roots and Session identifiers; user-authored tool text remains user data and may itself contain sensitive strings. Authentication identifies the reporter, not execution or truth. These events use `peerToolObservation`, distinct from replaceable OpenAPI evidence. The text backend can include multiple file events; the OpenAPI facts backend reports them as unsupported evidence rather than extracting invented facts.

The original durable outbox, exact payload digest, matched receipts, reserved terminal capacity, and pending withdrawal apply to both source modes. Termination excludes every current report from that grant; it does not delete history or recall bytes already delivered. Untagged OpenAPI sources and their payload digests retain their existing representation. Tool-mode records use explicit tags, and strict restored records preserve their source association. This is forward reading of supported representations, not a downgrade guarantee.

## Alternatives considered

**Require an OpenAPI selector for every file.** Code and prose do not have a supported OpenAPI operation. Artificial selectors would misrepresent tool events as complete artifact snapshots and still require per-file setup.

**Accept arbitrary caller-authored publications.** That bypasses source/tool association, owner-generated attribution, and bounded structured omissions. A report can contain untrusted text while retaining an enforceable collection permission.

**Keep only the latest event per path.** An Edit describes a reported transformation, and a failed operation does not replace file contents. Collapsing events into a current file would assert state the owner has not observed.

**Create a separate tool-contribution permission protocol.** The existing contribution identity, consent, recovery, and terminal rules apply unchanged. A source discriminant extends that authority without introducing a second write ledger.

## Consequences

Ordinary permitted work on different files can contribute without another selector or per-update sharing action. Reports still consume storage, context budget, and potentially an automatic activation. This decision does not provide recipient-specific semantic consolidation, general conflict resolution, or evidence that a model uses the information effectively.

Focused [Task tests](../../../../packages/collaboration/development-task/tests/peer-contribution.spec.ts) cover source/tool mismatch, bounded admission, exact retry, durable provenance, and terminal history. [Scope tests](../../../../packages/collaboration/scope-access/tests/tool-contribution.spec.ts) cover online approval, distinct file reports, owner restart after a lost reply, independent receiving, and withdrawal. Keyless model-request acceptance and browser checks belong to the consuming scenarios; they are not live-model quality or physical cross-machine evidence.
