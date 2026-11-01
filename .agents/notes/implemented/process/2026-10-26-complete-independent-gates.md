# Agent Note: Complete independent validation gates

Status: implemented

English | [中文](2026-10-26-complete-independent-gates.zh.md)

## Problem

Gate-level fail-fast interrupts independent validation to save runner time. Its process-tree cancellation caches numeric PIDs and process-group ids across asynchronous observations. A process can exit and its id can be reused before escalation, so that cache cannot establish which process a later signal will affect. A generation-aware PID list still cannot identify an unobserved process group's lifetime. The historical [fail-fast decision](../../archived/process/2026-08-27-gate-runner-fail-fast.md) trades complete diagnostics for that additional cancellation machinery.

## Decision

The [gate scheduler](../../../../scripts/run-gates.ts) runs every independent check to completion within its configured concurrency bound. Failed `needs` dependencies still skip their dependents; `after` waits for settlement; `allowFailure` retains its separate aggregate policy. Child exit, signal, spawn error and attributable output retain their ordinary observations. No validation inventory, coverage threshold, worker limit or job deadline is reduced.

The scheduler has no fail-fast option, executor AbortSignal, detached-child launch, PID sampling or tree termination. It observes direct process completion and does not promise descendant quiescence. Tests and applications retain responsibility for their own resources; product subprocess and terminal providers keep their independent disposal requirements.

The current [CI workflow](../../../../.github/workflows/ci.yml) uses standard hosted jobs and no gate-level cancellation flag. GitHub documents [fresh hosted machines](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners) and [workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation); those job-level mechanisms do not provide per-gate cleanup while siblings run. Local foreground interrupt delivery does not cover a signal sent only to the coordinator or descendants that detach.

## Verification

The [scheduler tests](../../../../scripts/run-gates.spec.ts) retain graph validation, dependency ordering, worker bounds, output streaming and actual child outcomes. A held sibling and queued independent check survive an earlier failure. A real CLI fixture makes its first leaf fail and verifies every remaining independent leaf executes while the aggregate still exits unsuccessfully. The [workflow test](../../../../scripts/ci-workflow.spec.ts) rejects reintroduction of the cancellation flag.

## Alternatives considered

**Keep another gate-specific process controller.** Rejected because PID identity checks alone do not preserve process-group identity after the leader exits, and implementing another persistent owner duplicates product lifecycle infrastructure.

**Reuse the current subprocess provider.** Linux scopes and Windows Jobs offer stronger ownership, but its macOS and unavailable-native fallback still uses numeric process groups. Direct substitution neither preserves detached-survivor cleanup nor resolves id reuse, and it adds plugin/native bootstrap dependencies to validation tooling.

**Disable the CI flag while keeping cancellation available.** Rejected because it retains the unsafe optional implementation and its unsupported promises.

**Stop only queued independent checks after a failure.** Rejected because it withholds useful validation evidence and adds another policy without a current consumer.

## Consequences

A failed run may consume more runner time because independent checks finish; concurrency and job deadlines remain bounded. The scheduler gives up first-failure sibling cancellation and optional host-interruption tree draining. Removed process-generation controls document defects in that retired capability; they do not establish equivalent survivor cleanup in the complete-run scheduler. Any future gate-owned cancellation needs a persistent range owner on every supported platform and evidence for interruption and descendant quiescence before reintroduction.
