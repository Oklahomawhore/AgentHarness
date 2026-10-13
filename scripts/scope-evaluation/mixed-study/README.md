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

Each receiver performs ordinary local work before shared updates, retaining its original Session, Task and public project files. The Agents retain their owners' responsibilities; the scope controls shared context. The source uses actual Write, Bash and Edit operations; the same command first succeeds and later fails. Another owner writes and replaces unrelated documentation. Both receivers receive the same neutral work opportunity only after all mixed-work receipts settle. No intermediate request supplies the correction before the mixed input, and no history is removed.

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

The [Loader calibration](../../../packages/collaboration/scope-agent-contribution/tests/mixed-artifacts.spec.ts) uses four independent Loader compositions and an in-process transport. Ordinary controlled responses derive artifacts from actual admitted messages and public project data; they receive no condition or grading reference. Source tools, capture, projection, receiving context, file writes and Session persistence remain real. The check retains complete model-message reconstruction, original history and Task identity, complete context framing, source receipts, artifact seals and awaited cleanup.

Set `DSH_MIXED_ARTIFACTS` to an existing private output directory to retain one exclusively created JSON result per condition. Existing results are not replaced. Without this setting, temporary evidence is removed after the owned Hosts settle. No credential file or external model is needed.

The [native driver](../native-mixed-run.ts) launches five named `dsh` profiles with independent identities: a scope owner, policy and documentation sources, and two receiving Agents. Source tools and TCP/Noise delivery are real; ordinary and summary requests use the production HTTP provider adapter. Both recipients complete initial local work, then continue in their original Sessions only after all source receipts settle. Leaving retains the original local Task and consumes no model call.

The native acceptance check uses the semantic backend’s [current evidence and historical coverage counts](../../../packages/collaboration/development-task-context/README.md) within the fixed 8,000-byte complete managed allowance. It requires both semantic recipients to complete mixed HTTP work and pass independent policy, QA and current-verification grading while retaining both policy quotes and complete command evidence. N and reported retain their actual business failures and continue to the semantic condition. Original Sessions, local Tasks, histories and tools remain intact.

With built public packages available, run its local HTTP calibration:

```sh
DSH_NATIVE_DATA_EVALUATION=1 pnpm exec vitest run scripts/scope-evaluation/native-mixed-run.spec.ts --maxWorkers=1
```

Set `DSH_MIXED_NATIVE_EVIDENCE_ROOT` to an existing private directory to retain uniquely allocated results, actual HTTP requests, dispatch ledgers, source receipts, Session bytes, original Task state, sealed artifacts and awaited cleanup. Controlled HTTP replies derive decisions from message contents and public files. Failure controls exercise cumulative call exhaustion, missing usage and cancellation; later conditions stop after runtime or accounting failure. A business grade failure in N or reported does not stop the comparison.

For explicit execution, use the [ordinary study's route configuration and registration phases](../data-study/README.md#register-and-run), adding `--protocol mixed` to `prepare` and setting `limits.contextBytes` to exactly `8000`. The manifest fixes conditions `N`, `reported`, `semantic`. `ordinary.maxCalls` spans both initial and mixed work for one receiving Session per condition; `semantic.maxCalls` covers the semantic owner. The maximum is `6 × ordinary.maxCalls + semantic.maxCalls`, with no automatic retries. Source-controlled requests are counted separately. Preparation and preflight perform zero model calls.

<a id="limits"></a>
## Limits

An explicit capacity-failure control supplies a legal oversized summary with the same source input, two policy citations and 8,000-byte limit. It checks the exact projection-budget error and a persisted request containing withdrawn context without an ordinary HTTP dispatch. Partial artifacts and the complete summary audit remain available, and cleanup must finish. The separate Loader calibration uses different identity and local-context overhead.

The controlled summary identifies the registered policy reports deliberately. A passing summary-path artifact does not show that a real model can select those reports, interpret corrections, or produce useful work. The protocol records mechanism, artifact validity and current-evidence availability separately. Its unit checks reject stale policy and command results; the default reported backend retains its actual omissions rather than changing selection for this fixture.

Local HTTP calibration does not test physical devices or autonomous response latency. Live execution requires an independently authorized account and model; a configured call ceiling does not grant that authorization or guarantee completion. Existing live protocols cannot substitute their different inputs or budgets for this comparison.

<a id="dev-note"></a>
## Dev Note

[Mixed-work artifact calibration](../../../.agents/notes/implemented/testing/2026-10-08-mixed-context-artifact-calibration.md) records the separation between visible evidence, completed artifacts and model benefit.
