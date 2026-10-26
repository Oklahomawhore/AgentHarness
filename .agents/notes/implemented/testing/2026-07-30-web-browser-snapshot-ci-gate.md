# Agent Note: Required CI gate for web browser expected outputs

Status: implemented

English | [中文](2026-07-30-web-browser-snapshot-ci-gate.zh.md)

## Problem

The [keyless web browser e2e lane](2026-07-24-web-gui-browser-e2e-lane.md) runs only under the local `pnpm run test:web` command, and PR CI does not compare Web expectations under `snapshots/web/` or `apps/web/tests/expected/`. A PR that changes user-visible web output can therefore remain green when its expected outputs are not refreshed; when any later branch explicitly runs `DSH_SNAPSHOT=refresh`, it backfills the earlier change and produces a diff unrelated to that branch. Ordinary local runs already default to read-only replay, so the gap is mandatory enforcement at the PR level, not a ban on writes in refresh mode.

## Decision

For Linux PRs, the `node 24 / consumers` job runs the full web browser replay/compare suite. [scripts/run-gates.ts](../../../../scripts/run-gates.ts) injects `DSH_SNAPSHOT=replay`, so a mismatch fails without rewriting expected outputs. The current [workflow](../../../../.github/workflows/ci.yml) leaves `DSH_WEB_SNAPSHOT_WORKERS` unset and selects the serial `test:web:built` command.

The consumer job owns the build, so `apps/web/dist` and package `lib/` directories remain in its workspace for the browser suite. CI installs Chromium and its system dependencies at the lockfile-selected Playwright version. The [hosted CI decision](../process/2026-10-25-agentharness-hosted-ci.md) owns disposable runner selection; the workflow has no browser-cache restore or standby job.

Local `pnpm run test:web` continues to build first and then run the full browser suite serially; `test:web:built` is the serial entry point for existing build artifacts. Developers explicitly run `DSH_SNAPSHOT=refresh pnpm run test:web` only after confirming that user-visible output changed intentionally, review every expected-output diff, and then verify again in replay mode that no files are written.

An explicit `DSH_WEB_SNAPSHOT_WORKERS` value greater than one selects `test:web:ci`. Its [coordinator](../../../../scripts/run-web-snapshots.ts) first runs `hmr-live.e2e.ts` and `cordis-tool-round.e2e.ts` as separate serial Vitest invocations, then runs remaining files in one pool at the supplied worker count. HMR mutates built workspace state; Cordis owns a lifecycle-sensitive approval and steering sequence. Each child inherits stdio, and the enclosing gate streams its output through `run-gates`. This optional coordinator does not set the current CI worker budget.

The required browser comparison runs in the Linux consumer job because these scenarios target POSIX. The native Windows and Node compatibility jobs do not provision Chromium. The required CI verdict depends on consumer-job success, so a browser comparison failure fails that verdict.

Historical local replays measured six workers at about 65–71 seconds and twelve workers at about 50 seconds. These measurements describe those configurations, not current hosted-runner capacity. Browser snapshots wait for `built-package-invariants`; independent gates can overlap after their own prerequisites settle.

## Alternatives considered

**Continue requiring only local runs.** Rejected: execution depends on developer memory, which is precisely why stale goldens drift across PRs, and cannot guarantee that the PR introducing a behavior change carries its own expected-output diff.

**Run CI in `refresh` mode and then check the working tree.** Rejected: checking after writing turns the assertion mechanism into a generator; if the working-tree check is wired incorrectly, it can turn a regression into a passing expected-output update. Replay compares the existing goldens directly and has a smaller failure surface.

**Create a standalone browser job and rebuild the entire repository.** Rejected: it would duplicate dependency installation and the publishable build. The existing Linux consumer job already owns that build and is part of the unified required verdict.

**Run HMR and Cordis inside the parallel pool.** Rejected because HMR mutates shared built state and the Cordis approval continuation requires a serial preflight. Every other file shares one bounded pool; dedicated long-file processes add scheduling code and leave part of a reduced worker budget idle after those files complete.

**Replace real Chromium with jsdom snapshots.** Rejected: jsdom does not cover the browser, HTTP/SSE carriage, or the composition of real client plugin bundles. It remains useful for fast lower-layer feedback, but cannot replace the assembled browser chain.

## Consequences

Every qualifying PR compares the current Web assembly with committed browser expected outputs. The cost is Chromium provisioning and a complete browser run in the consumer job; the existing build is reused. A worker-budget change requires a completed end-to-end measurement rather than an elapsed-time estimate. The gate makes no claim of cross-platform browser consistency. A Playwright/Chromium upgrade that changes ARIA output requires an explicitly reviewed refresh.
