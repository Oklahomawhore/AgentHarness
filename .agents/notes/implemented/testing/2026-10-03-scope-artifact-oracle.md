# Agent Note: Scope artifact oracle

Status: implemented

English | [中文](2026-10-03-scope-artifact-oracle.zh.md)
## Problem

Successful transport and context inclusion do not establish that a receiving agent changes its work correctly. A model that acknowledges an update can still emit obsolete request fields or tests that accept every implementation. An oracle that shares answer bytes with a recipient also invalidates the result.

## Decision

The [scope evaluation owner](../../../../scripts/scope-evaluation/README.md) checks actual frontend requests and QA behavior against controlled correct implementations and explicit mutants. Fixture objects and source strings must come from its controlled registry. The offline runner records source and fixture bytes before execution, refuses result replacement, and labels every output as an oracle self-check with zero model trials.

A separate file workbench exposes exact file permissions without an arbitrary shell. It rejects traversal and symbolic links but does not claim OS isolation. The [controlled execution decision](2026-10-03-scope-native-evaluation.md) owns the Docker isolation and report-origin limits; the oracle still rejects unreviewed model artifacts.

## Alternatives considered

**Acknowledgements or matching output strings.** These do not show correct code or discriminating tests. Executed request behavior and mutation checks are the outcome being measured.

**Treat controlled responses as collaboration trials.** Deterministic fixtures establish that a checker recognizes known behavior; they cannot establish what a model will do with context. Model trials retain separate registration, denominators and usage evidence.

**Directory separation or Node permissions as a security guarantee.** Separate working directories do not restrict reads. Node's permission model is not a malicious-code sandbox. The offline checker accepts only its own reviewed sources; Node permissions do not replace its execution policy.

## Consequences

The separate [data-artifact study](2026-10-04-scope-data-artifact-study.md) accepts unknown JSON through a fixed interpreter; it does not replace this executable-source restriction.

The repository gains reproducible artifact grading without claiming product benefit. The five synthetic cases are narrow and do not cover arbitrary semantic decisions. The offline command does not establish live provider behavior, fair baseline comparisons, or model cost. The [runtime calibration decision](2026-10-03-scope-native-evaluation.md) owns execution evidence beyond artifact recognition.
