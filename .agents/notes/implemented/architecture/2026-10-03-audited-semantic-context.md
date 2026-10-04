# Agent Note: Audited recipient-directed semantic context

Status: implemented

English | [中文](2026-10-03-audited-semantic-context.zh.md)

## Problem

Independent agents produce reports for different responsibilities. Copying every authorized Write/Edit body to each recipient consumes context without establishing which updates matter. A language-model summary can select and condense reports, but it also introduces model cost, omitted evidence, and a generated result that cannot be reproduced by replaying only the original reports.

## Decision

The [semantic backend](../../../../packages/collaboration/development-task-context/README.md#semantic-backend) uses the existing LLM service to summarize captured authorized reports for the Task objective and recipient label. The Task and scope consumers retain authorization, recipient binding, and adoption checks. A label guides relevance; it never grants access. The model makes an explicit decision for each ordinary source and cites exact excerpts for every included source. Missing or unrelated references reject the output. Citation validation establishes source correspondence, not semantic accuracy.

Deterministic selection excludes withdrawn source intervals and superseded typed observations before inference. Current structured OpenAPI evidence and terminal notices remain mandatory records. The model does not replace those records with its interpretation. Inherited evidence remains separately attributed frozen history. Complete projected text must fit its configured byte budget; an invalid or over-budget summary is not replaced with an older result.

An isolated JSONL persistence service owns one stable auxiliary audit Session. Preparing that Session without publishing it prevents live-store enumeration, while a separate persistence directory also prevents ordinary Session queries from discovering it. The audit records and flushes an exact effective request and cumulative reservation before model dispatch. It records and flushes bounded raw output, reported usage, and the exact validated projection before returning to the consumer. The delivered projection is logged in the receiving Session through the existing consumer.

Completed identical requests reuse the durable result. Restoration rebuilds each completed projection from recorded raw output and the captured sources. Concurrent identical readers share one computation; losing the last reader cancels that computation. Disposal drains work and audit writes before releasing the writer. Failed attempts with recorded outcomes can retry within the remaining reservation limit; a request interrupted without a result remains an unknown consumed reservation and is not implicitly sent again. Configuration revisions do not reset the limit attached to the same audit identity.

## Alternatives considered

**Copy reports with deterministic field selection.** That remains useful for structured OpenAPI evidence, but does not condense arbitrary code and prose reports for different recipients.

**Let the model rewrite all scope state.** Withdrawal, known source coverage, and unresolved structured conflicts must not depend on a relevance judgment. The backend preserves these records separately.

**Keep only generated text in memory or the recipient Session.** That loses the exact auxiliary request, raw result, and cost evidence after restart. A provider-owned audit supports exact reuse while consumers retain their delivery records.

**Use an unpublished Session in ordinary persistence.** Query services scan persisted logs independently of live Session publication. Persistence isolation is therefore necessary to keep auxiliary requests out of ordinary conversation queries.

**Retry every missing outcome.** A process can stop after dispatch but before committing a result. An automatic repeat can duplicate a paid call; the reservation remains consumed and its outcome explicitly unknown.

## Consequences

Recipients can receive concise source-attributed updates without choosing individual reports. Summary inference adds latency and tokens, and relevance decisions can omit useful information. Exact excerpts do not prove that a summary preserves negation, uncertainty, or meaning. Configured call, byte, concurrency, and time limits bound execution without claiming an exact monetary cap when provider usage is absent.

Controlled-provider tests exercise source accounting, isolated persistence, revocation, cancellation, restart, and model-request projection. These checks establish plumbing and failure behavior; they do not establish real-model task improvement, summary fidelity, cross-machine performance, embedding communication, or product readiness.

The [semantic pilot](../../../../scripts/scope-evaluation/semantic-pilot/README.md) freezes six recipient/revision cells before dispatch and keeps execution phases exclusive so a rerun cannot silently reset consumed reservations. Production HTTP calibration isolates transport evidence from semantic review. Unknown usage stops later calls; an estimated cost threshold cannot substitute for provider billing enforcement. Human review remains necessary because structural citation checks cannot establish proposition fidelity.
