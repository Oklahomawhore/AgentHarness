# Agent Note: Controlled native scope evaluation

Status: implemented

English | [中文](2026-10-03-scope-native-evaluation.zh.md)
## Problem

An artifact checker can recognize known client behavior without proving that a receiving Session performs file work. Executing unreviewed artifacts also creates two separate risks: access outside the intended project and fabricated grading reports. File separation alone addresses neither risk.

## Decision

Four named `dsh` profiles exercise a source, a Task owner, and frontend and QA Sessions. Reviewed tool-call programs use ordinary production contribution hooks and passive scope consumption. A shared tool-return barrier separates source admission from recipient continuation. Recorded source receipts, owner events, actual requests, and restored Session prefixes establish that the same admitted update reaches the next request before file work resumes. This is runtime calibration, not inference.

The [native command](../../../../scripts/scope-evaluation/native-cli.ts) combines F1 no-sharing and recipient-facts runs with hidden Docker grading after artifact sealing, plus a cancellation control. Its recorded identities cover evaluation sources and explicitly resolved built entries rather than a complete dependency graph. Identical reviewed programs in both conditions keep this evidence separate from live model comparisons.

The [evaluation owner](../../../../scripts/scope-evaluation/README.md) retains the exact controlled-source registry while allowing its oracle to execute registered programs in Docker. The parent owns container identity, inspected restrictions, bounded cleanup, and removal evidence independently of the IPC proxy. The hidden oracle remains outside the mounted role directory.

Docker execution does not establish trustworthy report origin. Candidate tests and Node's test runner share a reporting process, so arbitrary artifacts remain rejected before execution allocation. An independent trusted reporter and a narrow operation channel are required before this checker can claim resistance to candidate report fabrication.

## Verification

The [native checks](../../../../scripts/scope-evaluation/native-run.spec.ts) cover F1 with and without shared facts and cancellation before tool return. The [Docker checks](../../../../scripts/scope-evaluation/docker-execution.spec.ts) cover inspected restrictions, verdict writes, terminal status, deadlines, and cleanup. The [oracle checks](../../../../scripts/scope-evaluation/oracle.spec.ts) retain the controlled-registry rejection before either execution mode allocates resources.

## Alternatives considered

**Treat directory or Node permission checks as OS isolation.** They do not provide the required confinement for unreviewed executable artifacts. Docker supplies a separate execution environment without changing which sources the checker accepts.

**Open raw grading as soon as containers work.** Confinement does not prevent a test from forging messages inside its own reporting process. The controlled registry avoids presenting this partial protection as an adversarial grading system.

**Build a general anti-cheating framework before exercising Sessions.** That would expand the checker without proving the collaboration path. The controlled restriction permits finite runtime calibration while retaining an explicit limit on what its results mean.

## Consequences

The checker can inspect and retain execution restrictions and cleanup evidence for its registered fixtures. It cannot accept arbitrary model-generated tests or treat a controlled response as a model trial. Model inference, quality comparisons, and cost-benefit measurements remain separate evidence; controlled executions record zero model trials and unknown model usage and cost.
