# Agent Note: In-job partitioned coverage

Status: implemented

English | [中文](2026-08-18-in-job-partitioned-coverage.zh.md)

## Problem

Native Windows coverage was the longest feedback path in the complete pull-request inventory. Keeping the instrumented suite in one single-worker Vitest process avoided the worker loss and Node 24 CJS lexer failures seen with larger in-process pools, but a failure could take more than fourteen minutes to appear and the gate runner withheld the child output until completion.

The optimization must retain every test and the merged per-file 100% thresholds. It must also stay inside the existing coverage job: splitting one suite across multiple workflow jobs would add checkout, installation, artifact transfer, and a merge job to the required topology.

## Decision

The ordinary `pnpm run test:coverage` command remains one Vitest invocation. Partitioning requires an explicit `DSH_COVERAGE_PARTITIONS` greater than one. The current [GitHub-hosted workflow](../../../../.github/workflows/ci.yml) does not enable partitioning; its worker budgets belong to that workflow. No elapsed-time trigger changes a running configuration. The [coverage-exempt heavy suite](../../archived/process/2026-07-31-coverage-exempt-heavy-suites.md) remains a separate required uninstrumented gate.

The entire `packages/typert/` group is exempt from source coverage and runs in the uninstrumented gate. Its compiler fixtures, catalog reproduction, loader, protocol, and registry assertions remain required. The shared [exempt roster](../../../../scripts/coverage-exempt.ts) selects every Typert package, including nested tests; both project exclusions and partition inventory consume that roster. Exemption removes coverage collection, not test or hook failures.

When partitioning is enabled, `scripts/run-gates.ts` selects `pnpm run test:coverage:partitioned` for the instrumented gate. The coordinator collects the filtered inventory through `vitest list --filesOnly`, removes the shared exempt roster, and assigns files by recorded duration using longest-processing-time allocation. Each partition receives a temporary config with separate project includes and one worker, avoiding Windows command-line limits and duplicate execution across projects. Empty partitions fail before launch. Children start from the heaviest partition, stream output, write separate blob reports, and disable individual coverage thresholds. Duration history stays in a gitignored local file; cross-job persistence requires the caller to restore it.

The coordinator waits for every child, validates that the blob directory contains exactly the expected files, and then runs one `vitest --merge-reports ... --coverage` command. Only that merged command applies the repository's per-file statement, branch, function, and line thresholds, so a partition is never judged against an intentionally partial inventory.

`DSH_COVERAGE_MAX_WORKERS` sizes the uninstrumented exempt gate and the ordinary non-partitioned path; it does not resize partition children. Source-only coverage resolves workspace imports through tsconfig paths to `src`. Tests that require built artifacts run only after their declared build dependency. The complete Windows mode retains both coverage gates after the complete build; the Linux coverage mode runs without a preceding build. Observational inventory runs after both coverage gates settle, including after failure, while pass-required dependencies still block their consumers.

## Failure and output semantics

Partition children stream stdout and stderr through the coordinator. The coverage gate opts into `run-gates` streaming, so test progress and failures reach CI logs as they occur without buffering the complete log in the scheduler. The coordinator also retains a bounded 64 KiB combined tail per child; when a child settles unsuccessfully, it prints the spawn error, exit code, or signal and repeats that tail before validating the complete blob set, keeping the specific Vitest failure beside the final partition diagnostic.

A normal failed test still emits a blob through `--coverage.reportOnFailure`, allowing the merge to report the complete coverage state before the coordinator returns failure. Spawn failure, signal termination, non-zero exit, a missing or extra blob, or a failed merge all make the gate fail. The coordinator removes only its owned coverage tree and unlinks a link-shaped path instead of recursively following it.

## Verification

`scripts/coverage-partitions.spec.ts` pins argument construction, package-script separator removal, one-worker partitions, weighted longest-processing-time assignment (including a case that fails when assignment ignores recorded weights), the single merged threshold command, failed-test merging, failure diagnostics before complete-blob validation, waiting for sibling partitions after a spawn failure, and link-safe cleanup. `scripts/run-gates.spec.ts` pins opt-in selection, invalid-count rejection, both native Windows coverage gates' complete-build dependency, the complete Windows inventory with its blocking split, and unbuffered streamed output. React fake-timer cases that can move between partitions advance timers inside `act()`; geometry-dependent portal tests stub their element rectangles so a different shard schedule cannot turn deferred updates or jsdom coordinates into coverage-only failures.

Historical native Windows comparisons measured two partitions near 405 seconds and sixteen at 112.66–122.01 seconds under an earlier gate order. Two Linux runs with two partitions measured 276.68 and 282.27 seconds. Those completed measurements describe their original hosts and configurations; they do not establish capacity or expected timings for the current standard GitHub-hosted runners. Separate single-worker partitions remain available when measured startup or isolation costs justify them.

## Alternatives considered

**Use workflow-level sharding.** Rejected because multiple jobs repeat setup and need artifact upload, download, and a merge dependency. The selected partitioning uses multiple processes inside one job and one workspace.

**Raise the Vitest worker count inside one instrumented process.** Rejected because completed Windows trials at higher fan-out exposed worker exits, fixture instability, and Node 24 CJS lexer failures. Separate single-worker processes preserve isolation while still executing the selected partitions concurrently.

**Use one partition count on every host.** Counts depend on completed measurements of the target host. Earlier Linux and Windows tuning used different counts before aligning them after Windows startup failures. The current workflow leaves partitioning disabled rather than inheriting those historical capacity assumptions.

**Apply thresholds independently in each partition.** Rejected because every partition intentionally sees only part of the suite and would report false uncovered files. Threshold ownership belongs to the merged report.

## Consequences

Coverage pays one Vitest startup/configuration cost per partition and one report-merge cost, but it avoids another workflow topology and keeps one final threshold verdict. Partition output may interleave, while the partition start labels and Vitest file identities retain attribution.

Linux and Windows can use the same optional coordinator. The workflow owns their selected execution modes and worker budgets; this note does not prescribe runner capacity. Local coverage stays unpartitioned unless the caller explicitly supplies a valid partition count greater than one.

Future tuning starts from completed runs at one fixed configuration. Slow progress alone never raises partition count or outer concurrency, because repeated restarts would erase the only evidence needed to choose a stable setting.
