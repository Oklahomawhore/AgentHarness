# Agent Note: Reconstruct file text from authorized reports

Status: implemented

English | [中文](2026-10-07-reported-file-context.zh.md)

## Problem

A small file can accumulate enough Edit reports to exhaust a recipient's context allowance. Whole-chain admission then excludes every report even when the latest reported file text would fit. Sharing a private tool outcome or reading the original file would disclose contents outside the existing report permission.

## Decision

The [Task context package](../../../../packages/collaboration/development-task-context/README.md#behavior) provides `/reported` with a distinct backend identity. It derives text from eligible complete live Write/Edit reports without filesystem access or a model call. Web selects this provider by default; `/text` preserves original publications and `/semantic` retains its independent input and validation rules. All providers use the existing delivery and durable projection mechanism.

Reconstruction extends [complete Write checkpoints](2026-10-04-tool-report-checkpoints.md) without claiming current filesystem knowledge. A complete live Write establishes only a reported base. Capture-wide continuity, supported literal edits, and unchanged authorization constrain the derived record. Unknown sequence positions, historical initialization, unsupported characters or operation results, and additional publication meaning retain the atomic original chain. Known other-file observations can establish intervening capture positions. Current and frozen snapshots never supply one another's base.

Derived text carries an explicit reported-state warning and compact dependency evidence. Exact selected sources remain in the projection and Session record, including operations that return to an earlier value. Withdrawal and recipient exclusion run before reconstruction. Complete output and intermediate text remain subject to the recipient's byte limit; failure cannot restore an obsolete base. The provider uses exact activation comparison and creates no execution permission.

## Alternatives considered

**Increase the context allowance.** This postpones failure while repeated edits continue to accumulate. The new representation permits some bounded files to remain available within the existing allowance; it does not bound stored history.

**Export the native tool's full resulting file.** The result can contain private preexisting content that the input-only report permission did not authorize. A separate file-state permission is required before that broader source could be used.

**Treat the reconstruction as current file truth.** Other writers and unreported operations remain unobserved. The derived record states only what selected reports imply.

**Replace every text backend with reconstructed contents.** Consumers may require original publications, and semantic quotes use a separate audited source format. A distinct provider preserves those choices without changing existing logged projections.

## Consequences

Eligible files remain useful after long edit sequences without an auxiliary model call. Files lacking an authorized complete Write, unsupported reports, and large derived files can still exhaust the allowance. Exact coverage, publications, and request history keep growing. This decision establishes neither semantic equivalence nor cost savings, model understanding, or physical-device connectivity.

Verification covers whole-frame budgets, sequence gaps, Unicode and literal replacement, original-report fallback, withdrawal, recipient exclusion, and snapshot isolation. Real native tool acceptance compares independently read file contents with the receiving request. Recorded Session and Python SDK scenarios retain complete provenance and reconstruct delivery from durable events. Scripted model replies verify transport and representation, not task quality.
