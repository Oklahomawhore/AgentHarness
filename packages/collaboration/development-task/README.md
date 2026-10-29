---
description: "@deepseek-ai/dsh-development-task owns immutable Root, Fork, and Merge lineage for shared-context atoms"
kind: "package-reference"
---
# Development Tasks

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-task` shares admitted context through immutable Root, Fork, and Merge lineage. A Task contains a name, initial context, publications, fixed parent revisions, and runtime metadata. It has no task lifecycle workflow. Its owner can approve trusted Mesh observations or separately authorized independent-peer contributions. Each Task deterministically names one hidden Room used only for repairable runtime membership.

## Table of Contents

- [Semantics](#semantics)
- [Observed context admission](#observed-context-admission)
- [Remote observation authority](#remote-observation-authority)
- [Independent peer contributions](#independent-peer-contributions)
- [Owner-local contributions](#owner-local-tool-contributions)
- [Remote API](#remote-api)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


<a id="semantics"></a>

## Semantics

- Root has no parent, Fork pins one exact parent revision, and Merge pins at least two distinct parent Tasks at fixed revisions, bounded by `maxMergeParents` on creation. Parent edges never change; replica admission and recovery reject repeated parent Task ids.
- Fork and Merge create independent Tasks without mutating or changing the state of their parents.
- Inherited blocks contain each parent's name, initial context, and admitted publications at the selected revision. Creation, replica admission, and recovery require Root to have no inherited block and Fork/Merge to have one whose ordered parent ids and revisions match the creation relation. Each source’s name, initial context and retained publications must match that parent revision; retained publications form an unchanged ordered subset. This service does not capture private Sessions, tool or editor history, or model reasoning.
- Callers may exclude selected publications before the 256 KiB default block limit is enforced. Oversized blocks fail with `LIMIT_EXCEEDED`; content is never truncated.
- Each Agent session has an opaque binding id. Several sessions of the same Cursor, Codex, or Claude identity may connect to different Tasks without replacing one another.
- A binding commits before Room reconciliation. Exact committed assignment replicas return the current binding without another write or notification, including after acknowledgement or clear. Joining the new Room and leaving an unused prior Room report independent outcomes, while model context reads only the binding. A leave command can require the displayed checkout epoch; the owner queue rejects a stale command before ending local contributions or clearing a newer binding.
- Storage and Mesh callers validate event field types and integer ranges before restore or replica admission. The Task service verifies authenticated ownership, sequence continuity, revisions and lineage before durable publication.
- Background Room repair records failures per Task and permits another retry after settlement. Only one background repair runs at a time; disposal stops its timer and waits for the active repair.

<a id="observed-context-admission"></a>

## Observed context admission

Trusted Host adapters call `admitObservedContext` with an authorized observation and the binding interval captured when its operation started. The executor requires a locally owned Task, a local Agent participant, and the same current participant, Task, binding, and epoch. Stale or cleared bindings fail before deduplication. Capture permissions and observation filtering remain the adapter's responsibility; this method has no Remote endpoint.

The caller supplies a lowercase SHA-256 digest of the source identity, including its binding interval. The method trims text and enforces `maxTextBytes`, matching explicit publication. Repeating the same source and effective content returns `reused` with the original publication and no new revision; different text, publisher, or observation metadata fails with `INVALID_REQUEST`. A new source returns `published` after the existing persistence event succeeds. Task-log replay restores deduplication without a separate ledger. Distinct sources remain separate even when their text matches. The [admission decision](../../../.agents/notes/implemented/architecture/2026-10-02-observed-task-context-admission.md) records the ownership and retry rules.

An optional versioned OpenAPI observation records a complete supported operation sample, an invalid document, an unavailable file, or an ended grant. Task admission stamps its source digest, observer node, and original binding interval. The reader owns file authorization, byte digest, artifact identity, and sample sequence; the sequence expresses observation order within one observer, artifact, and grant, not operation causality. New sources must advance that sequence without changing the publisher, operation, source name, or binding interval. Exact admitted retries remain reusable after newer samples. Copying observation JSON into an explicit publication never creates trusted metadata, and Remote publication cannot supply it.

`revokeObservedArtifact` is a separate Host-only terminal admission. It requires matching prior evidence for the publisher, artifact, grant, operation, source name, and binding interval, so it can end a local chain after a binding was cleared or its Agent left. Revoked chains cannot accept new samples; a new authorization needs a new grant identity. Every live local chain reserves one event inside `maxEventsPerTask`, and ordinary writes cannot consume that slot. Revocation consumes its own reservation without exceeding the event limit. `maxTextBytes` separately bounds the complete observation JSON, including admission fields; inherited blocks include that metadata in their existing whole-block budget and digest.

Storage and Mesh retain the same optional metadata, and publication children are immutable. Records without metadata retain their serialized content and inherited block ids. The SQLite Task unit uses version 1. An observation attributes sampling to its source node; a separate Task owner records remote admission. A block digest verifies content integrity. None of these proves that the receiving Host read the artifact. Consumers decide which observations qualify as current evidence.

<a id="remote-observation-authority"></a>

## Remote observation authority

The Task owner explicitly approves a remote Agent, binding, and binding epoch before that source can submit observations. Approval names a known remote Agent but does not require its assignment replica to have arrived. Candidate discovery uses replicated current bindings and can lag; a candidate is not proof of a Claude connection or permission to read files. The source adapter owns local capture authorization.

Both generic observations and artifact samples require the approved interval. The Mesh dispatcher supplies the source node from the authenticated peer, and Task admission checks it against the approval. A publication records the interval; artifact evidence separately records its observer. The receipt identifies the original persisted owner event and revision. An exact retry returns that receipt even after later publications or interval termination. The response contains only the outcome, original publication, and receipt, so Task history does not enlarge each acknowledgment. A receipt proves Task persistence, not model delivery or use.

Either the source or the Task owner can permanently end an interval. One durable owner event closes admission, derives deterministic revocations for every current artifact chain in that interval, and adds a typed withdrawal notice for generic observations. Every active interval reserves one terminal event, including when no sample exists. Structured samples reserve a successor sequence; their deterministic withdrawals fit the admitted observation’s complete JSON byte bound. An end request can precede approval and leaves a terminal identity that a delayed approval cannot reopen. Persistence failure leaves the interval unchanged; transport failure requires retrying the same identity. Admission already ahead of termination in the owner queue can commit; new sources behind it are rejected.

Termination keeps historical publications and frozen inherited snapshots. Consumers use the withdrawal metadata when selecting current context; ending an interval does not remove text already admitted by a model. The protocol assumes mutually trusted Mesh members: their shared credential and replicated Task data do not provide independent user identity or per-Task read isolation.

<a id="independent-peer-contributions"></a>

## Independent peer contributions

An authenticated Host facade calls `openPeerContribution` for one local Root Task, contributor PeerId, capture generation, and exact source permission: an OpenAPI operation, explicit file/command observation permission, complete final-answer permission, or a combined native or Claude selection. The grant bounds lifetime, sample count, and complete sample bytes. It grants neither local collection nor Task reads, Room membership, or arbitrary publication. The source adapter separately authorizes capture; transport supplies the authenticated peer. Peer publications record `peerContribution` and OpenAPI `peerObservation`, ordered `peerToolObservation`, `peerTurnOutcome`, or `peerStopReport`, without inventing a participant or Mesh node. Parsing a public capture proposal creates no authority.

Approval, sample admission, and termination share the Task owner queue and event log. `admitPeerContribution` derives attribution and canonical report text; OpenAPI sources additionally receive a logical artifact identity. New samples must advance their sequence within that grant; duplicates do not consume quota. Exact sample and terminal retries return the original receipt even after termination or a lower new-admission byte limit; they do not perform a new expiry write. Altered content or authorization is rejected. Receipts include the original event kind, revision, source identity, and complete payload digest; they prove durable admission, not tool execution, file authenticity, model delivery, or truth.

File-tool samples contain a reported outcome, root index, relative path, tool fields, and explicit whole-field omissions. Failure reports omit attempted success text. The owner checks the allowed tool and source kind before deriving attribution and canonical text; absolute roots and Session identifiers are not metadata fields. Tool observations append in sequence and never replace a file snapshot. Ending the grant withdraws every current report from that interval while retaining history. The [tool-observation decision](../../../.agents/notes/implemented/architecture/2026-10-03-independent-tool-observations.md) defines the evidence limits.

Recorded-work reports require the source's explicit version-2 `recorded-local-tools` permission. Their version-2 origin identifies the frozen selection and execution evidence with digests, and canonical text labels the report as a previously recorded attempt that was not re-executed or checked against the current file. Ordinary tool grants reject this variant; local reports never acquire historical origins. Recorded and live reports share the same ordered grant, quota, retries, and terminal withdrawal. The [recorded-work decision](../../../.agents/notes/implemented/feature/2026-10-07-recorded-work-on-scope-join.md) explains source selection and independent permission.

Version-3 tool sources explicitly authorize `fileContent: completed-native-file`. Local and peer version-3 reports retain their original tool arguments and separately include the LF text returned by the native operation with its SHA-256 digest, or an explicit whole-field omission (`tool-failed`, `budget`, or `unavailable`). This is operation-result text, not a current disk snapshot. Admission and restore require matching completed-file permission in a version-3, version-4 or version-6 source; ordinary and historical permissions cannot acquire it. Failed reports cannot include completion text. Receipts and inherited-block digests cover the complete authorized result.

Version-4 tool sources explicitly authorize exact foreground commands and working-directory root indices, optionally alongside Write/Edit and completed-file permission. File tools may be empty; command selectors cannot. Command outcomes retain independent exit, signal, timeout and abort fields, whole stdout/stderr fields or explicit budget omissions, and provider truncation markers. Missing completion evidence or final tool failure is unavailable, never an inferred success. These reports record one execution, not verification of current code. Admission matches the exact selector and source version; old file and historical permissions cannot authorize them. Command receipts, inherited blocks and withdrawals retain the same complete evidence and interval identity.

`completed-turn-outcomes` version 5 authorizes complete final-answer reports with a matching SHA-256 digest. Local and peer admission retain `localTurnOutcome` or `peerTurnOutcome`, the original contribution authority and monotonic sample sequence. The whole result participates in receipt identity and immutable block verification. These are attributed Agent reports, not owner-approved facts; identical retries remain idempotent and ending the original permission withdraws its current reports.

`native-work` version 6 combines explicitly selected Write/Edit tools, exact commands and complete final answers under one capture, sequence and total sample allowance. Any nonempty category combination is valid; omitted categories gain no permission. Completed-file disclosure requires selected file tools. Admission preserves the individual version-1, version-3, version-4 and version-5 results and rejects historical initialization. Every selected category participates in receipt identity, immutable copying, restore and terminal withdrawal. Changing categories requires a new authorization; existing tool or answer permissions cannot expand implicitly.

`claude-work` version 7 separately authorizes any nonempty selection of Write/Edit, exact Bash commands and complete Stop reports under one capture and sample allowance. File reports retain version 1; `claude-command-observation` retains original Hook stdout, stderr, interrupted or error fields, with whole-field omissions. A Hook event does not establish a process exit code. `claude-stop-report` and `peerStopReport` preserve the complete reported assistant text, its SHA-256 digest and `stopHookActive`; they do not prove the turn ended. Public metadata contains no Claude prompt or Session identifiers. Native admission rejects these sources and results; old grants cannot authorize them. All selected reports participate in receipt identity, immutable copying, restore and withdrawal.

`endPeerContribution` permits source withdrawal or owner revocation. It records one terminal event, derives withdrawal evidence and a notice, and rejects later activation or new samples. Even an empty grant reserves that event inside `maxEventsPerTask`; an end arriving before approval leaves a permanent tombstone. Historical samples and inherited snapshots remain intact. `expirePeerContributions` serializes due expirations for locally owned Tasks of any origin; the facade also reconciles expiry during startup. Sample-byte limits apply to new admission; restore preserves historical bytes and rejects capacity settings that prevent retiring a live grant.

Host consumers call `currentContextView` before and after delayed projection. It commits due local expirations before capturing context, and rejects a Mesh replica containing active direct peer or owner-local capture evidence because that replica cannot prove current owner authorization. Local Fork and Merge Tasks, replicas without active direct peer or owner-local capture evidence, and frozen inherited history remain readable. A new terminal notice invalidates the captured projection; an ordinary newer sample can wait until the next request. `contextView`, the Remote `context` method, and `peerContributions` expose stored history or state without this current-authority check.

<a id="owner-local-tool-contributions"></a>

## Owner-local contributions

Host-only `openLocalContribution`, `admitLocalContribution`, `localContributionStatus`, and `endLocalContribution` authorize the Task owner's own Agent without self-peer transport. One local Root Task, participant, binding epoch, capture generation, and explicit individual or combined native source selection identify the permission. Lifetime, sample count, and complete sample bytes are finite. The source consumer separately owns source consent and collection; Task admission checks the original assignment and requires the same current local Agent binding for new samples.

Each capture reserves one terminal event. Status and current-context reads commit expiry or stale-binding termination before returning; clear and checkout retire captures before changing the binding. Checkout validates its optional session label before retiring any capture. Explicit ending remains possible after the Agent leaves or its binding changes. Ending before opening leaves a closed generation. Exact admitted retries return their original receipts after termination, while changed permissions or new samples cannot reopen it. Persistence failure prevents reporting the affected authority transition as complete.

Local publications retain the real `publishedBy` participant, original binding epoch, and `localContribution` authorization; ordered `localToolObservation` reports retain file paths or command selectors and whole-field omissions. These identifiers can be derived from a Session identity and are visible to authorized Task readers. Absolute capture roots are not metadata fields; tool text may itself contain private data. Reports describe observed operations, not complete current files. Ending withdraws all current reports in the interval through the context backends while preserving stored history and frozen inherited snapshots. The source consumer owns ending on disposal or restart; Task admission alone does not collect tools or schedule idle Agents.

<a id="remote-api"></a>

## Remote API

Task projections and context changes use `developmentTasks/list`, `get`, `lineage`, `create`, `publishContext`, and `context`; `create` returns `{ task, runtime }`. Session binding uses `developmentTaskAssignments/list`, `checkout`, and `clear`, with an internal acknowledgement endpoint for delivered revisions. `checkout` is the internal Remote name for connecting or switching one binding, not a Task lifecycle operation.

Binding-change notifications carry `null` after a clear so the complete event can cross the JSON Remote transport. Local assignment lookup still returns `undefined` for an unbound session; the durable binding log records `task-cleared`. Host-only `latestAssignment(participantId)` selects the last retained `task-bound` event whose current binding still belongs to that participant, in durable order. Equal or decreasing timestamps, binding-name order and later acknowledgements cannot change that selection. Clearing it exposes the preceding retained binding; another participant's reuse of a cleared binding ID cannot select their assignment. Selection grants no reading, collection or automatic-work permission.

`acknowledge` requires a positive safe-integer revision and accepts optional `expectedBindingEpoch: { nodeId, seq }`, identifying the `task-bound` event for the expected binding interval. The serialized executor rejects a mismatched interval with `INVALID_REQUEST` before recording the acknowledgment, including when a session switched away and back to the same Task. The native context consumer always supplies this guard. Assignment transitions are validated before persistence, including sequence, binding identity and acknowledgements bounded by the current Task revision without regression; rejected transitions do not consume durable positions. Task names and initial context are validated before inherited blocks are persisted. Task replicas also reject conflicting duplicate identities before persistence; identical retained events return the current projection without another persistence notification. The invariant checks Task identity and revision against the retained log and current projection, including when timestamps are equal. An acknowledgment records delivery of a revision; it does not prove that the model read every fact.

<a id="configuration"></a>

## Configuration

All retention and retry fields are required. An omitted catalog limit uses the smaller of 200 and `maxLineageTasks`; an omitted lineage limit uses `maxLineageTasks`. Explicit limits above that configured capacity are rejected. The Web bundle uses 10,000 Tasks, 2,000 events per Task, 16 Merge parents, 256 KiB inherited blocks, a 500-Task lineage result, and a five-second hidden-Room retry interval.

Startup rejects a reduced `maxEventsPerTask` that cannot hold restored local events plus revocation reservations for live local artifact grants, active remote intervals, independent peer contributions, and owner-local captures. Increase the configured capacity; restoration does not delete or rewrite records to fit it.

<a id="model-experience"></a>

## Model Experience

None, as the Task service exposes Host APIs and delegates model admission to its context Consumer.

#### KV Cache effect

None in this package; it does not assemble model requests.



## Known Limitations and Deferred Work

- Tasks cannot be deleted, rebased, or have parent edges edited.
- Merge records and attributes source context but does not resolve semantic conflicts.
- Arbitrary event-revision checkout and complete Session inheritance are not supported.
- Observed-context admission does not capture external work or verify semantic truth. Independent peer authentication, local capture permission, and Task read grants belong to their respective consumers.

<a id="dev-note"></a>

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
