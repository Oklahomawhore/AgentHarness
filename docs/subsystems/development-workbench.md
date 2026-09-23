# Development Workbench

English | [中文](development-workbench.zh.md)

The development workbench is a profile-configured Host task controller and human-facing Web panel. It gives repository-specific development servers a Harness-owned process tree, bounded output, and one or more browser views without making project paths, commands, or ports product constants. The shipped Web bundle composes an empty service; a profile supplies entries when the deployment needs the panel.

Source: [`packages/host/dev-workbench/src/index.ts`](../../packages/host/dev-workbench/src/index.ts), [`packages/host/dev-workbench/src/types.ts`](../../packages/host/dev-workbench/src/types.ts), and [`packages/client/ui-dev-workbench`](../../packages/client/ui-dev-workbench)

## Task records

`DevWorkbenchEntryId` and `DevWorkbenchViewId` are branded, profile-authored ids matching `[a-z][a-z0-9-]*`. A `DevWorkbenchView` carries one id, label, and normalized HTTP(S) URL without embedded credentials. Several views on one entry share one process and lifecycle.

`DevWorkbenchEntrySnapshot` contains the configured id, label, argv, working directory, and views plus the current `idle`, `running`, `stopping`, `stopped`, `exited`, or `failed` phase. A process id exists only while the task is live. Start and finish timestamps, exit facts, and spawn failure text appear when known. Stdout and stderr are bounded retained tails with independent lossy flags and optional spill paths; this implementation does not enable spill files. `DevWorkbenchSnapshot` preserves configuration order across all entries.

Optional `DevWorkbenchReadinessSnapshot` records a deployment-owned, credential-free URL and an independent `checking`, `delayed`, or `ready` state, plus the latest check time, status, or transport error. The task process stays `running` while readiness is delayed. Accepted status codes, polling interval, request timeout, and warning threshold are explicit profile configuration.

The service serializes start and stop operations per entry. A start on a live task returns its current snapshot; a start after settlement replaces the retained process handle and output. Stop cancels and awaits readiness work, terminates the complete tree, and waits for quiescence. Harness disposal applies the same ordering to every live task. Stdin remains disconnected.

The browser consumes the generated Remotes through [`dsh-api-remotes`](../../packages/api/remotes/README.md). Its footer action hides for an empty inventory. The open panel portals above layout resize handles, polls once per second, waits for configured readiness before mounting the selected iframe, and exposes a lower-left resize handle with a small-screen near-fullscreen fallback. Browser-local validated preferences retain panel dimensions, selected task, and selected view across reloads.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdevworkbench--devworkbenchservice"></a>

### `ctx.devWorkbench` — `DevWorkbenchService`

Host runtime for configured development tasks.

```ts cordis-catalog
/**
 * Read every configured task and its retained output.
 * @returns Point-in-time task state in configuration order.
 */
@Remote('list') list(): DevWorkbenchSnapshot

/**
 * Start one task, or return its current state when it is already live.
 * @param id - Configured task identity.
 * @returns State after the serialized start operation.
 */
@Remote('start') start(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot>

/**
 * Stop one task's complete process tree and wait until it is gone.
 * @param id - Configured task identity.
 * @returns State after the serialized stop operation reaches quiescence.
 */
@Remote('stop') stop(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot>
```

Source: [`packages/host/dev-workbench/src/index.ts`](../../packages/host/dev-workbench/src/index.ts)
<!-- END GENERATED cordis-surface -->
