# Agent Note: Online contribution approval retains source consent

Status: implemented

English | [中文](2026-10-03-online-contribution-approval.zh.md)

## Problem

Transferring a contribution request and returning an approval invitation requires the source user to coordinate two exchanges. A browser cannot safely complete approval by itself: it can close, lose a response, or display a capture that the user has already cancelled. Reducing that coordination must preserve separate source file permission and owner publication authority.

## Decision

The [owner service](../../../../packages/collaboration/scope-access/README.md) issues one application entry for an owned Root Task and explicit source mode. Possession grants neither read nor publication permission. The authenticated source claims the entry with one durable capture identity, exact source permission, and explicit expiry, sample-count, and byte limits. The owner approves that selection within the source's limits; another peer, capture, source, or changed consent cannot reuse it.

One serialized owner operation persists the complete approval decision before opening the [Task grant](2026-10-03-independent-scope-contributions.md). Task events remain the sole publication authority. Status and retries recover the same planned grant after a lost response or an interrupted Task commit. The application record coordinates approval; it cannot authorize samples in place of a Task event.

Cancellation and rejection persist terminal intent before ending the associated grant. A retained planned grant can be ended before its delayed opening, producing a durable terminal Task event that prevents reopening. Confirmation waits for the exact terminal authority. An entry without a planned or existing grant can be closed without inventing one; this closes that entry, not the owner's ability to authorize a separate manual request. Entry expiry blocks new applications and approval while allowing status and cancellation of an already approved selection.

The [source adapter](../../../../packages/collaboration/claude-scope/README.md) persists its exact local collection policy and bounded consent to automatic activation before sending the application. A Host-owned worker retrieves approval while the page is closed. Each session has one worker; peer requests run outside the global local-mutation queue. Every response is adopted under the current capture identity and cancellation signal, with a fresh read-permission relationship check and online grant verification. No response can expand the local selection or its consent limits.

Source leave and SessionEnd stop local capture before remote confirmation. A pending application cancellation survives without an invitation and cannot use the manual path's empty-selection cleanup. Restart resumes retained intent under the original local peer identity. Disposal aborts and awaits worker completion. An unavailable owner remains a visible pending state; an identical entry can use an explicitly supplied replacement address without changing its capture or reviving cancellation.

The [client controls](../../../../packages/client/ui-emergence-center/README.md) keep source consent and owner approval explicit. Committed state notifications invalidate local observations; the UI rereads authority after management operations and unknown outcomes. The [manual controls](2026-10-03-independent-contribution-controls.md) remain available for separate approval and route recovery. Read subscriptions and finite automatic model execution continue to require their own authorization.

## Alternatives considered

**Poll from the source page.** Closing or reloading the page would suspend approval retrieval and lose the association with a pending local cancellation. A durable Host-owned worker keeps the user's prior consent effective without a second paste.

**Treat the application record as a write grant.** Its persistence is separate from Task admission. Using it as authority could publish after a failed approval commit or confirm withdrawal before the Task has ended the grant.

**Clear cancellation when no invitation is present.** Approval may already be committed even when its reply was lost. Retaining the entry and capture identity lets the owner recover and terminate that authority.

**Run peer polling inside the shared adapter queue.** An unresponsive owner would delay unrelated session hooks and local stopping. Only local snapshots and result adoption occupy that queue.

## Consequences

One entry exchange replaces the request-and-return exchange for this online path. Users still select a session, local collection policy, and contribution limits, and the owner still approves them. Delivery requires a reachable advertised peer address and running Hosts; this decision provides no public discovery, relay, or NAT traversal. Supported [source modes](2026-10-03-independent-tool-observations.md) determine which authorized Write/Edit work contributes; an entry does not authorize arbitrary tool output.

Focused Host tests exercise lost replies, restart, consent bounds, approval and cancellation ordering, delayed verification, unrelated-session progress, and worker disposal. Browser acceptance is owned by the [online contribution scenario](../../../../apps/web/tests/online-contribution-scope.e2e.ts). These checks establish setup, permission, and delivery behavior with controlled inputs; they do not establish real-model task quality or physical cross-machine usability.
