# Agent Note: Ordinary Agent data artifacts

Status: implemented

English | [中文](2026-10-04-scope-data-artifact-study.zh.md)

## Problem

The controlled JavaScript oracle cannot grade unknown model-generated programs without trusting their reporting process. [Controlled native calibration](2026-10-03-scope-native-evaluation.md) remains a separate runtime check; registered correct outputs cannot measure whether ordinary receiving Agents use shared updates in their own work.

## Decision

The [JSON work study](../../../../scripts/scope-evaluation/data-study/README.md) accepts bounded policy and QA data. A fixed parent-owned interpreter computes actual request traces; candidate artifacts contain no executable expressions or score fields. The parent seals final bytes after Session completion and independently checks policy behavior and QA discrimination. Reference inputs and mutants stay outside model-accessible files and tools.

A fixed source Agent uses production native file tools and contribution capture. Ordinary recipients use the production HTTP provider and exact file permissions. Explicit N/E/R registrations preserve the same public projects, goals and budgets. The source updates finish before recipients begin; this experiment makes no claim about sustained adoption in an existing Session. Runtime failure, invalid data, behavioral failure and local HTTP calibration remain distinct outcomes.

Finite reservations precede model dispatch. Missing usage stops subsequent dispatches; an existing execution directory prevents automatic retry with renewed budgets. Static preflight checks recorded bytes without loading credentials. These measures make an authorized run reviewable without treating an unexecuted registration as model evidence.

## Alternatives considered

**Remove the JavaScript registry restriction.** Container isolation does not authenticate candidate reports. The existing [controlled oracle decision](2026-10-03-scope-artifact-oracle.md) remains applicable to executable programs.

**Score acknowledgements or exact JSON strings.** Acknowledgements do not establish behavior, and equivalent JSON can have different bytes. The fixed interpreter evaluates request traces while the original submitted bytes remain auditable.

**Build a general code grader first.** A bounded data task permits autonomous unknown outputs with independent grading. It sacrifices programming-task breadth and cannot establish general collaboration quality.

## Consequences

The study provides an executable ordinary-Agent entry and a trustworthy data interpreter, not a demonstrated product benefit. Same-host tools do not claim OS confinement. Single-wave synthetic outcomes do not establish cross-device reliability or continued withdrawal behavior. Artifact, registration and native calibration checks are owned by the [evaluation reference](../../../../scripts/scope-evaluation/data-study/README.md#evidence-and-limits).
