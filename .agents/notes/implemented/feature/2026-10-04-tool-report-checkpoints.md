# Agent Note: Complete Write reports replace earlier file evidence

Status: implemented

English | [中文](2026-10-04-tool-report-checkpoints.zh.md)

## Problem

Repeated complete Write reports leave obsolete contents competing for the recipient's context budget. Selecting each report independently can admit a smaller old Write while omitting its larger replacement, or retain a base Write while excluding a later Edit. Sending every report to a semantic model also repeats evidence whose replacement is already explicit.

## Decision

The [text and semantic Task context backends](../../../../packages/collaboration/development-task-context/README.md) select a retained report segment for each file. A successful Write with complete content starts the segment; earlier reports in the same chain are marked superseded. The segment contains that Write and every later report, including Edit operations, failures, and omitted fields. An empty complete Write qualifies. A failed or incomplete Write and every Edit leave the existing segment intact. Equal sequence numbers are retained.

A chain includes the contribution authorization interval, declared source name and tool set, root index, and exact relative path. Local and peer contributions stay separate. Current Task evidence and each inherited frozen snapshot are selected independently; a live replacement cannot remove inherited evidence. Withdrawal takes precedence over supersession. Original Task publications and receiving Session history remain intact.

The text provider admits each retained file segment as a whole under the recipient's byte budget. If the segment does not fit, all its reports receive budget omissions; selection does not fall back to a stale base. The semantic provider removes superseded reports before inference while preserving its existing source accounting and output validation. [Recipient backend identity](../architecture/2026-10-02-recipient-task-context-backend.md) changes invalidate cached projections for changed selection rules.

[Semantic audit restoration](../architecture/2026-10-03-audited-semantic-context.md) uses the saved request, captured sources, and raw reply. It does not apply current selection rules to an earlier completed result. Changing the backend revision does not reset cumulative reservations for the same audit identity. [Duplicate report removal](../bug-fix/2026-10-04-independent-context-delivery.md) remains independent of segment selection.

## Alternatives considered

**Budget each report separately.** This permits an old base to survive without its replacement or dependent Edit. Whole-segment admission preserves the relationship at the cost of omitting a large segment entirely.

**Keep only the latest report.** A final Edit may require an earlier base, and a final failure does not establish new contents. A complete successful Write provides a narrower, explicit replacement signal.

**Reconstruct the current file by applying Edit reports.** Authorized reports do not include every possible external write or read. Reconstruction would imply filesystem knowledge that the backend does not possess.

**Ask the semantic model to resolve all repeated history.** This spends input budget on deterministic replacement and makes supersession depend on inference. The model remains responsible for relevance and summarization of retained evidence.

## Consequences

Recipients receive the latest reported segment, not an independently verified current filesystem snapshot. Source identity and authorization changes prevent replacement across chains. Long Edit sequences and omission metadata still grow with retained history; this decision does not establish constant space, lower billed cost, or better model work.

Verification covers complete and incomplete Writes, empty content, failures, authorization and snapshot isolation, and indivisible text budgets. Authored Session scenarios check actual native tool writes, receiving model requests, semantic input replacement, withdrawal, retained earlier evidence, and detached replay. Durable composition verification checks older audit restoration and cumulative reservations across backend revisions. These checks do not establish live-model semantic fidelity or task improvement.
