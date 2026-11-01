# Agent Note: runner-owned temporary storage for PR CI

Status: implemented

English | [中文](2026-09-06-pr-ci-runner-temporary-storage.zh.md)

## Problem

The Linux failover pool runs multiple runner instances on one VM. PR coverage and snapshot processes use the operating-system temporary directory for transformed modules and fixtures. Files outside the runner's temporary directory escape its job cleanup, including when cancellation prevents process-level disposal. Exhausting that shared directory makes unrelated PRs fail before tests execute.

## Decision

The [hosted CI decision](../process/2026-10-25-agentharness-hosted-ci.md) supersedes persistent-runner allocation. Each disposable job owns its checkout, package installations, temporary files, and browser processes; fixtures still allocate unique roots, register cleanup immediately, and await quiescence.

Package-manager caches follow the standard setup actions; each hosted job installs its own browser. CI does not reuse the upstream private pool, export a shared-host toolcache preload, or reclaim temporary files belonging to another process.

The fixture synchronization and placement decisions below remain active independently of runner selection. The [archived deployment runbook](../../archived/process/2026-07-26-ci-failover-runbook.md) records the shared-host incident context.

## Recorded ACP completion order

The [ACP diagnostic scenario](../../../../snapshots/session/subagent-acp-diagnostic/cordis.snapshot.yml) holds its scripted background response until `job_output` owns the completion wait. Without that synchronization, a fast child can publish a legitimate job notice between the recorded parent steps. A scenario-local wrapper releases the child after the jobs service registers the completion waiter; the mock watches an exclusive marker in the private test workspace and closes the watcher after release. The fixture restores the wrapped method on disposal. The recorded Session bytes and production job-notice behavior stay unchanged.

## Workspace-grant fixture placement

The headless `session-sandbox-root` fixture declares `workspace.parent: outside-temp`, not a home-filesystem dependency. Its allocator uses a sibling of the canonical platform temp root where the parent is writable and avoids system temporary grants, otherwise home, and rejects a cwd already covered by automatic temporary write grants. On the failover runner this keeps the test on the data volume without making its write succeed through a temporary-directory exemption. The filesystem-sandbox containment tests use the same allocator for their workspace and denied sibling; they register cleanup immediately after successful acquisition. Atomic workspace allocation, recorded Session bytes, and the independent expected file remain unchanged.

## Live verification and browser fixture inputs

The installed-wheel live SDK test externally replaces the created file with a fresh host-only challenge before asking the model to verify it; the verification prompt does not reveal that value. Both turns must contain model-requested tool calls, and the verifier compares the returned value and actual file bytes.

The reference-composer fixture maps the known home-abbreviated workspace display to its existing cwd token and waits for the current exact suggestion set before selecting; neither host paths nor stale suggestions determine its result. The shared browser timezone, Inspector subscription synchronization, and PowerShell completion behavior follow the [existing platform-test decision](2026-09-07-pwsh-ci-observable-completion.md).

The advanced Python snapshot pauses only its matching workflow child’s first pre-step until the parent’s durable workflow membership event is observed. The fixture supports either event-arrival order and cancels pending waits on abort or disposal. This pins the scenario’s cross-session ordering without sorting notifications or changing production scheduling.

The queue snapshot moves the pointer away from the Stop/Send control and waits for its Send tooltip to close before capture. Workspace-management tests select the sole non-blank Session by its actions affordance, not row position, and select that Session before asserting that archiving it removes the empty Ungrouped bucket. Hover behavior, queue contents, durable archive identity, and reload assertions remain unchanged. The concurrent spill isolation test keeps each root paired with its run result rather than assuming filesystem allocation completion order matches input order.

## Alternatives considered

**Delete shared temporary files from a PR job.** Another runner may still own those files. Repository jobs must not reclaim a shared directory by pathname or age.

**Retry tests or enlarge timeouts.** Neither recovers storage or gives residual files a cleanup owner.

**Rely only on disposable runners.** A disposable machine does not give concurrent fixtures unique resources or synchronize their observations. Each fixture still owns allocation and cleanup.

## Consequences

Output honoring `TMPDIR` follows the job lifetime instead of accumulating in unmanaged host storage. Package-manager caches use the setup actions; browser processes and files belong to the disposable job. This does not reclaim existing shared temporary files, guarantee filesystem capacity, or clean files the runner account cannot remove. Operators still own historical residue, disk provisioning, and jobs outside this PR workflow.

Linux bwrap and Landlock workspace-write profiles grant literal `/tmp` and the workspace, not an inherited `TMPDIR` outside it; confined fixtures must place temporary writes in those granted paths. The [snapshot spill helper](../../../../packages/test-support/session-snapshot/src/harness.ts) separates fixed-length logical locators from atomically allocated live storage. A fixture-only adapter delegates saves to the real local spill provider and resolves only locators saved by that run to their live files. Recorded preview lengths, omission counts, and retrieval assertions remain unchanged; no files are allocated at the logical `/tmp/dsh-acp-snap-*` prefix. This change does not widen product sandbox grants.

The [hosted workflow tests](../../../../scripts/tests/agentharness-ci.spec.ts) verify disposable runner selection and required validation jobs. Fixture allocation and synchronization remain independently tested by their owners; workflow assertions alone do not prove host capacity.
