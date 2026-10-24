# Agent Note: Combine authorized work sources in one original Session

Status: implemented

English | [中文](2026-10-14-combined-native-work-sources.zh.md)

## Problem

A person's existing Agent commonly changes files, runs a check and explains the result in one turn. Separate file and completed-answer captures omit part of that evidence or require auxiliary Sessions solely to satisfy the sharing system. [Human-owned collaboration](../process/2026-10-05-collaboration-follows-human-responsibility.md) connects existing responsibilities without assigning another Agent to represent the same person.

## Decision

The [native collector](../../../../packages/collaboration/scope-agent-contribution/README.md) accepts a distinct version-6 native-work source. File operations, exact foreground commands and complete final answers are explicit selections in one application. At least one category is selected; approval binds every selection. Existing permissions retain their original meanings and acquire no combined authority. Both local and peer management require file-source roots to be string arrays and tools to be arrays of declared names. Validation precedes directory resolution, capture replacement and consent retention. Unknown `sourceKind` values are rejected; omitting the field keeps the declared tool-observation selection. Final answers can quote private user inputs, so their disclosure remains a separate choice within the form.

One capture per Session and local/remote role owns the grant, monotonic sequence, cumulative sample allowance, retained leases and durable outbox. File, command and answer samples retain their existing evidence types and original provider or turn provenance. Each sample must match a selected category. Stop, expiry or revocation terminates every category in that capture while preserving independent read permission. Failed persistence retains bounded retryable work; cold restoration terminates disclosure. A retained active record does not authorize disclosure without its live capture runtime. Remote reconciliation checks runtime ownership inside the management queue before receiving or peer work. Missing runtime keeps termination retryable even with an empty outbox, so a failed stop write cannot resume delivery or defer cleanup until expiry. A capacity rejection remains visible while retained samples and unfinished reservations together fill the allowance, including when an earlier completion finishes saving.

The source uses wire protocol 6 and explicit durable row successors. Earlier protocol and row forms reject this authority. Committed Session generations remain unchanged. Exact payload digests bind all permission fields; the reported representation shares complete grants without changing result meanings, and semantic capture and activation bind the new source selection. Existing input domains retain their backend representations. [Reported allocation](2026-10-14-source-fair-reported-context.md) still bounds complete fields, preserves source representation, and reports omissions. Tool outcomes do not certify an answer; a later answer alone does not supersede an earlier one.

Historical initialization, changing categories during an active capture and concurrent remote-owner captures are excluded. [Completed-answer provenance](2026-10-14-completed-answer-contributions.md) excludes failed, canceled, steered and managed automatic turns. Finite automatic receiving requires its own local goal and allowance. Combined disclosure grants no execution authority, and an automatic receiving case does not establish a bidirectional automatic-answer cycle. The Claude adapter rejects these native entries, activation and restored records because it lacks the required native completion evidence; [original Claude work](2026-10-14-original-claude-work-contributions.md) uses a separate permission and report types.

## Alternatives considered

**Several captures per Session.** Runtime ownership, queues, outbox rows, read adoption and self-report omission identify one capture per role. Several captures expand lifecycle state and ask people to manage multiple permissions for one body of work.

**Helper Sessions for tool work and explanations.** This changes a person's Agent arrangement solely for the communication system and cannot demonstrate collaboration between the original Sessions.

**Infer the answer from files, or include it under file consent.** Tool observations do not contain a person's complete explanation. Answers can disclose private material beyond the authorized file operations.

**Rely on generated request codecs.** Strict dispatch validates source kinds and array fields, but development SRC dispatch can reach the same management methods without those codecs. These calls require the original selection arrays: string iteration or substring searches can introduce directories or tools that the caller did not select.

## Consequences

A single reviewed selection can transmit the original Session's ordinary file work, foreground checks and complete answers without per-update publish or recall calls. The source and recipient retain their independently assigned local Tasks, tools and histories. Same-command replacement preserves a current failure instead of an earlier success; independent answers remain attributable. Shared sample limits can be consumed faster, and complete context can still exceed a recipient's allowance. An omitted source must not be presented as full coverage or current truth.

Verification covers actual Loader tool and turn events, approval and denied categories, pre-consent exclusion, stale generations, shared capacity, failed saves, withdrawal and cold restoration. Actual JSON-file rename failures cover stopping with retained reports and with an empty outbox for both roles. A cancellation barrier and negative control check that a superseded failed checkpoint cannot report a later storage error; the SDK command scenario preserves its normal withdrawal Session after storage recovers without another stop call. TypeScript/Python SDK and browser cases compare durable source results, owner receipts and actual recipient requests under a fixed 8,000-byte allowance, with new writer records preserving historical oracles. A separate idle case checks independently authorized automatic requests and cumulative spending; a manual receiving prompt is not automatic execution evidence.

[Cold restoration tests](../../../../packages/collaboration/scope-agent-contribution/tests/restore.spec.ts) reject mismatched Session row keys, changed peer identity and reduced retention capacity without changing the persisted source files; inventory limits count each Session once across local and remote domains.

Native verification is an intermediate capability. External CLI acceptance requires the already running original Session, documented installation and network steps, precise authority, actual input and timing; a new Harness Session is not a substitute. Controlled providers do not prove real-model understanding, factual agreement, privacy beyond the selected source, or physical-device latency. Real-model and physical-device acceptance remain separate requirements. The implemented tool-source, completed-answer and allocation decisions remain active because their provenance and representation rules still apply.
