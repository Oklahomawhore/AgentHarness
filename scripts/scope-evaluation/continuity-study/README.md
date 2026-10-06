# Existing Session policy continuity

English | [中文](README.zh.md)

## Summary

This reference defines `payment-policy-continuity-v1`, a separate protocol from the [single-wave JSON study](../data-study/README.md). One receiving Agent keeps the same live Session and read permission while the source reports an initial policy, corrects it, and ends its contribution. The experiment checks successive current-work artifacts; it does not compare collaboration benefit against an unbound control.

## Table of Contents

- [Phases and permission](#phases-and-permission)
- [Current work and history](#current-work-and-history)
- [Registration and limits](#registration-and-limits)
- [Evidence](#evidence)
- [Dev Note](#dev-note)

<a id="phases-and-permission"></a>
## Phases and permission

Three independent named `dsh` Hosts own the source A, scope owner O and receiver B. A uses real native file tools and contribution capture. B uses the ordinary HTTP provider and bounded data tools. Its initial goal describes a continuing task and the requirement for current source support; it contains no future correction value. The owner supplies original reports in E and recipient-specific semantic projections in R.

B binds once with an explicit automatic goal and finite allowance. The source writes its initial policy, then waits before the correction until B's automatic turn completes and its artifacts are sealed. The parent next admits the successful correction and failed edit before allowing B's next natural pre-step to proceed. Finally, A ends its contribution while B retains its active read subscription. The resulting terminal publication triggers the third automatic turn. The parent supplies no intermediate user message, new goal, replacement Session or renewed binding.

Private source and pre-step barriers fix this experiment's interleaving. They wait without changing model messages or choosing artifact contents. Requests still pass through production authorization and projection. These barriers mean the results cannot establish uncoordinated latency or behavior under arbitrary concurrent source changes. R may summarize an intermediate revision before the complete correction phase arrives; those attempts count toward its unchanged total budget.

Source contribution termination withdraws current support without revoking B's read grant. Revoking that read grant is a different lifecycle path: the Host must stop automatic work, rather than starting another model turn merely to write a blocked artifact. This study does not run that separate branch or simultaneous B/C receivers.

<a id="current-work-and-history"></a>
## Current work and history

The [public project and grader](../continuity-study.ts) use a small current-work decision alongside the policy. A ready decision embeds the complete policy and must match the independently sealed policy file. The parent executes both against its private reference inputs and rejects unchanged or failed-edit retry values. Public diagnostics retain their initial baseline and never disclose the private grade. Payment requests are interpreter traces; no payment service is called.

A blocked decision states that current evidence is unavailable. After contribution withdrawal, the parent requires this decision, requires the policy bytes to match the preceding sealed phase, and performs no new payment requests. A ready decision fails even if its policy used to be correct. During supported phases, an always-blocked decision fails. Historical policy files and earlier Session events remain valid evidence of previous work; withdrawal does not require erasing them, changing the old policy back, or making a model forget prior messages.

Every phase retains both original artifact bytes and hashes. Invalid JSON, mismatched ready policy, behavioral error and runtime failure are separate outcomes. A completed automatic turn does not imply a correct artifact; a failed artifact grade does not by itself stop the remaining phases.

<a id="registration-and-limits"></a>
## Registration and limits

Use the supported Node runtime and built public packages. The same explicit route configuration as the single-wave study applies. Prepare a new directory with the distinct protocol:

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts prepare --run /tmp/payment-continuity --seed 20261004 --config /absolute/study-config.json --execution live --protocol continuity
pnpm exec tsx scripts/scope-evaluation/data-cli.ts preflight --run /tmp/payment-continuity
```

Preparation and preflight read no model credentials and launch no Hosts. They freeze protocol identity, E/R conditions, projects, oracle, source and built-entry fingerprints, and Node identity. An existing phase cannot be rerun. Changed registered inputs require a new directory and registration.

Execute only with an explicitly selected account and model:

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts execute --run /tmp/payment-continuity
```

Each E/R Session has three automatic activations, at most four model steps per turn, and one `ordinary.maxCalls` allowance spanning all three turns. Twelve ordinary calls permit the maximum registered steps; fewer calls remain a deliberate smaller allowance, not a reason to reset the counter. `semantic.maxCalls` covers the whole R owner, including intermediate computations. The total maximum reservations are `2 × ordinary.maxCalls + semantic.maxCalls`. Waits, model operations and cleanup have finite registered deadlines. Unknown usage blocks subsequent dispatches. There is no automatic retry or monetary spending cap.

<a id="evidence"></a>
## Evidence

The [runner](../native-data-run.ts) seals source outcomes and durable owner receipts before each receiving phase. Its phase record retains the original binding and Session identity, subscription state, actual request interval, owner revision, completed automatic evidence, reconstructed JSONL prefix and independent artifact grade. Earlier checkpoints are retained separately. Forced Host termination invalidates execution; cancellation preserves completed phases and available partial evidence.

The opt-in [HTTP calibration](../native-continuity-run.spec.ts) requires `DSH_NATIVE_DATA_EVALUATION=1` and built public dependencies. Its server returns controlled artifacts, so passing checks establish transport, scheduling and grading behavior only. The [pure grader tests](../continuity-study.spec.ts) reject unsupported ready decisions and distinguish legitimate retained history from new use. The [registration tests](../data-cli.spec.ts) require `DSH_NATIVE_EVALUATION=1` and exercise static refusal before dispatch.

This protocol establishes no real-model accuracy, cost saving, two-person onboarding or cross-device reliability without separate evidence. E/R are mechanism trials with potentially different summary costs, not a randomized quality comparison. The [decision record](../../../.agents/notes/implemented/testing/2026-10-04-scope-data-artifact-study.md) owns the distinction between current use and retained history.

## Dev Note

None.
