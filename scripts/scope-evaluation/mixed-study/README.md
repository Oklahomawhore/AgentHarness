# Mixed work with independent artifacts

English | [中文](README.zh.md)

## Summary

This reference defines `payment-mixed-work-v1`: a separate calibration of no sharing (`N`), complete reported operations (`reported`), and recipient-specific summaries (`semantic`) with an 8,000-byte managed context limit. It preserves independent receiving Sessions and local Tasks while checking actual input and separately graded JSON artifacts. Controlled responses establish measurement mechanics, not model quality or collaboration benefit.

## Table of Contents

- [Equal work opportunities](#equal-work-opportunities)
- [Independent grading](#independent-grading)
- [Execution and evidence](#execution-and-evidence)
- [Limits](#limits)
- [Dev Note](#dev-note)

<a id="equal-work-opportunities"></a>
## Equal work opportunities

Each receiver performs ordinary local work before shared updates, retaining its original Session, Task and public project files. The source uses actual Write, Bash and Edit operations; the same command first succeeds and later fails. Another owner writes and replaces unrelated documentation. Both receivers receive the same neutral work opportunity only after all mixed-work receipts settle. No intermediate request supplies the correction before the mixed input, and no history is removed.

The [study definition](../mixed-study.ts) derives source policy, initial projects and hidden grading inputs from the same seeded field names. Every condition uses the same source trajectory, project inputs and complete context limit. The condition selects communication, not artifact contents. The older [single-wave study](../data-study/README.md) keeps E as original text; the [continuity study](../continuity-study/README.md) keeps its separate E/R protocol.

<a id="independent-grading"></a>
## Independent grading

The client maintains payment policy JSON; QA maintains independently executable data cases. The existing [artifact grader](../data-artifacts.ts) checks complete request traces and required behavioral mutants using parent-owned references. Neither receiver sees hidden inputs or reference artifacts.

Each role also writes a verification observation. Its grade distinguishes accurate reporting of available evidence from obtaining the latest source result. Without an admitted command result, `unavailable` is accurate but does not count as current evidence or complete work. A command failure describes that reported execution; it does not prove the current disk or deployment remains invalid. Missing, malformed, corrupted or stale artifacts remain explicit failures.

<a id="execution-and-evidence"></a>
## Execution and evidence

Run from the repository root with installed dependencies and the supported Node runtime:

```sh
pnpm exec vitest run scripts/scope-evaluation/mixed-study.spec.ts packages/collaboration/scope-agent-contribution/tests/mixed-artifacts.spec.ts --maxWorkers=1
```

The [owning calibration](../../../packages/collaboration/scope-agent-contribution/tests/mixed-artifacts.spec.ts) uses four independent Loader compositions and an in-process transport. Ordinary controlled responses derive artifacts from actual admitted messages and public project data; they receive no condition or grading reference. Source tools, capture, projection, receiving context, file writes and Session persistence remain real. The check retains complete model-message reconstruction, original history and Task identity, complete context framing, source receipts, artifact seals and awaited cleanup.

Set `DSH_MIXED_ARTIFACTS` to an existing private output directory to retain one exclusively created JSON result per condition. Existing results are not replaced. Without this setting, temporary evidence is removed after the owned Hosts settle. No credential file or external model is needed.

<a id="limits"></a>
## Limits

The controlled summary identifies the registered policy reports deliberately. A passing summary-path artifact does not show that a real model can select those reports, interpret corrections, or produce useful work. The protocol records mechanism, artifact validity and current-evidence availability separately. Its unit checks reject stale policy and command results; the default reported backend retains its actual omissions rather than changing selection for this fixture.

This calibration is not a named-profile live runner, a physical-device test, or a measurement of autonomous response latency. A live comparison still requires an independently authorized model account, fixed cumulative calls, identical work opportunities and inaccessible grading data. The existing live protocols cannot substitute their different inputs or budgets for this comparison.

<a id="dev-note"></a>
## Dev Note

[Mixed-work artifact calibration](../../../.agents/notes/implemented/testing/2026-10-08-mixed-context-artifact-calibration.md) records the separation between visible evidence, completed artifacts and model benefit.
