/** Configurable local development tasks with managed process trees and bounded logs. */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DevWorkbenchEntryId,
  DevWorkbenchEntrySnapshot,
  DevWorkbenchSnapshot,
  DevWorkbenchView,
  DevWorkbenchViewId,
} from './types.ts'

export type * from './types.ts'

/** Configured browser destination for one task. */
export interface DevWorkbenchViewConfig {
  /** Stable key used by the browser view selector. */
  readonly id: string
  /** Human-readable tab label. */
  readonly label: string
  /** Absolute HTTP(S) destination without embedded credentials, rendered in the panel iframe. */
  readonly url: string
}

/** Trusted deployment-owned HTTP readiness policy for one task. */
export interface DevWorkbenchReadinessConfig {
  /** Absolute HTTP(S) URL without embedded credentials, probed without following redirects. */
  readonly url: string
  /** Status codes that establish service readiness. */
  readonly acceptedStatusCodes: number[]
  /** Delay between attempts. */
  readonly intervalMs: number
  /** Per-request timeout. */
  readonly requestTimeoutMs: number
  /** Elapsed time after which an unresolved probe is reported as delayed. */
  readonly warnAfterMs: number
}

interface ResolvedReadinessConfig extends Omit<DevWorkbenchReadinessConfig, 'acceptedStatusCodes'> {
  readonly acceptedStatusCodes: readonly number[]
}

/** One configured local development task. */
export interface DevWorkbenchEntryConfig {
  /** Human-readable task label. */
  readonly label: string
  /** Absolute working directory in the subprocess provider's execution world. */
  readonly cwd: string
  /** Absolute executable or bare PATH name. */
  readonly command: string
  /** Arguments passed without shell interpolation. */
  readonly args?: string[]
  /** Browser destinations served by this task. */
  readonly views?: DevWorkbenchViewConfig[]
  /** Optional HTTP availability check, independent from process liveness. */
  readonly readiness?: DevWorkbenchReadinessConfig
}

/** Development workbench deployment policy. */
export interface Config {
  /** Tasks keyed by stable, human-readable ids. */
  readonly entries: Record<string, DevWorkbenchEntryConfig>
  /** Per-stream in-memory output cap. */
  readonly maxOutputBytes: number
  /** TERM-to-KILL grace for each task's complete process tree. */
  readonly graceMs: number
}

interface ResolvedEntry {
  readonly id: DevWorkbenchEntryId
  readonly label: string
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
  readonly views: readonly DevWorkbenchView[]
  readonly readiness: ResolvedReadinessConfig | undefined
}

interface EntryRuntime {
  readonly spec: ResolvedEntry
  handle: SubprocessHandle | undefined
  phase: DevWorkbenchEntrySnapshot['phase']
  startedAt: number | undefined
  finishedAt: number | undefined
  outcome: SubprocessOutcome | undefined
  error: string | undefined
  readiness: DevWorkbenchEntrySnapshot['readiness']
  readinessController: AbortController | undefined
  readinessTask: Promise<void> | undefined
  tail: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Configured local development task runtime. */
    devWorkbench: DevWorkbenchService
  }
}

const ENTRY_ID = /^[a-z][a-z0-9-]*$/

function nonBlank(value: string, field: string): string {
  const resolved = value.trim()
  if (resolved.length === 0) throw new TypeError(`dev-workbench: ${field} must not be blank`)
  return resolved
}

function entryId(value: string): DevWorkbenchEntryId {
  if (!ENTRY_ID.test(value)) {
    throw new TypeError(`dev-workbench: entry id "${value}" must match ${String(ENTRY_ID)}`)
  }
  return value as DevWorkbenchEntryId
}

function viewId(value: string, owner: string): DevWorkbenchViewId {
  if (!ENTRY_ID.test(value)) {
    throw new TypeError(`dev-workbench: view id "${owner}.${value}" must match ${String(ENTRY_ID)}`)
  }
  return value as DevWorkbenchViewId
}

function resolveView(owner: string, config: DevWorkbenchViewConfig): DevWorkbenchView {
  const url = new URL(config.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`dev-workbench: view "${owner}.${config.id}" must use HTTP(S)`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError(`dev-workbench: view "${owner}.${config.id}" URL must not contain credentials`)
  }
  return Object.freeze({
    id: viewId(config.id, owner),
    label: nonBlank(config.label, `view "${owner}.${config.id}" label`),
    url: url.href,
  })
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`dev-workbench: ${field} must be a positive safe integer`)
  }
  return value
}

function resolveReadiness(
  owner: string,
  config: DevWorkbenchReadinessConfig | undefined,
): ResolvedReadinessConfig | undefined {
  if (config === undefined) return undefined
  const url = new URL(config.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`dev-workbench: readiness "${owner}" must use HTTP(S)`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError(`dev-workbench: readiness "${owner}" URL must not contain credentials`)
  }
  if (
    config.acceptedStatusCodes.length === 0
    || config.acceptedStatusCodes.some(code => !Number.isInteger(code) || code < 100 || code > 599)
    || new Set(config.acceptedStatusCodes).size !== config.acceptedStatusCodes.length
  ) {
    throw new TypeError(`dev-workbench: readiness "${owner}" acceptedStatusCodes must contain unique HTTP status codes`)
  }
  return Object.freeze({
    url: url.href,
    acceptedStatusCodes: Object.freeze([...config.acceptedStatusCodes]),
    intervalMs: positiveInteger(config.intervalMs, `readiness "${owner}" intervalMs`),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs, `readiness "${owner}" requestTimeoutMs`),
    warnAfterMs: positiveInteger(config.warnAfterMs, `readiness "${owner}" warnAfterMs`),
  })
}

function resolveEntries(config: Config): readonly ResolvedEntry[] {
  if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1) {
    throw new TypeError('dev-workbench: maxOutputBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.graceMs) || config.graceMs < 1) {
    throw new TypeError('dev-workbench: graceMs must be a positive safe integer')
  }
  return Object.entries(config.entries).map(([rawId, entry]) => {
    const id = entryId(rawId)
    if (!isAbsolute(entry.cwd)) {
      throw new TypeError(`dev-workbench: entry "${rawId}" cwd must be absolute`)
    }
    const views = (entry.views ?? []).map(view => resolveView(rawId, view))
    if (new Set(views.map(view => view.id)).size !== views.length) {
      throw new TypeError(`dev-workbench: entry "${rawId}" has duplicate view ids`)
    }
    return Object.freeze({
      id,
      label: nonBlank(entry.label, `entry "${rawId}" label`),
      cwd: entry.cwd,
      command: nonBlank(entry.command, `entry "${rawId}" command`),
      args: Object.freeze([...(entry.args ?? [])]),
      views: Object.freeze(views),
      readiness: resolveReadiness(rawId, entry.readiness),
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readinessActive(entry: EntryRuntime, handle: SubprocessHandle, signal: AbortSignal): boolean {
  return entry.handle === handle && entry.phase === 'running' && !signal.aborted
}

/** Host runtime for configured development tasks. */
export class DevWorkbenchService extends TypertRemoteService {
  static inject = ['subprocess']

  static Config: s<Config> = s.object({
    entries: s.dict(s.object({
      label: s.string().required(),
      cwd: s.string().required(),
      command: s.string().required(),
      args: s.array(s.string()).default([]),
      views: s.array(s.object({
        id: s.string().required(),
        label: s.string().required(),
        url: s.string().required(),
      })).default([]),
      // Schemastery object schemas default to {}; readiness must stay absent
      // unless the deployment supplies its complete policy.
      readiness: s.object({
        url: s.string().required(),
        acceptedStatusCodes: s.array(s.number().step(1).min(100).max(599)).required(),
        intervalMs: s.number().step(1).min(1).required(),
        requestTimeoutMs: s.number().step(1).min(1).required(),
        warnAfterMs: s.number().step(1).min(1).required(),
      }).default(undefined as never),
    })).required(),
    maxOutputBytes: s.number().step(1).min(1).required(),
    graceMs: s.number().step(1).min(1).required(),
  })

  private readonly entries = new Map<DevWorkbenchEntryId, EntryRuntime>()
  private accepting = true

  /** Create the workbench and validate every self-contained configuration fact. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'devWorkbench')
    for (const spec of resolveEntries(config)) {
      this.entries.set(spec.id, {
        spec,
        handle: undefined,
        phase: 'idle',
        startedAt: undefined,
        finishedAt: undefined,
        outcome: undefined,
        error: undefined,
        readiness: undefined,
        readinessController: undefined,
        readinessTask: undefined,
        tail: Promise.resolve(),
      })
    }
  }

  /** Own process-tree teardown and wait for task operations to reach quiescence. */
  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.accepting = false
      for (const entry of this.entries.values()) entry.readinessController?.abort()
      await Promise.all([...this.entries.values()].map(entry => entry.tail))
      for (const entry of this.entries.values()) entry.readinessController?.abort()
      await Promise.all([...this.entries.values()].flatMap(entry =>
        entry.readinessTask === undefined ? [] : [entry.readinessTask],
      ))
      const live = [...this.entries.values()].flatMap(entry =>
        entry.handle !== undefined && (entry.phase === 'running' || entry.phase === 'stopping')
          ? [entry.handle]
          : [],
      )
      for (const handle of live) handle.terminate()
      const settled = await Promise.allSettled(live.map(async (handle) => {
        await handle.done.catch(() => undefined)
        await handle.waitForExit()
      }))
      const failures: unknown[] = []
      for (const result of settled) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'dev-workbench: task teardown failed')
    }, 'dev-workbench.processes')
  }

  /**
   * Read every configured task and its retained output.
   * @returns Point-in-time task state in configuration order.
   */
  @Remote('list')
  list(): DevWorkbenchSnapshot {
    return { entries: [...this.entries.values()].map(entry => this.snapshot(entry)) }
  }

  /**
   * Start one task, or return its current state when it is already live.
   * @param id - Configured task identity.
   * @returns State after the serialized start operation.
   */
  @Remote('start')
  start(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot> {
    return this.enqueue(id, async (entry) => {
      if (entry.handle !== undefined && (entry.phase === 'running' || entry.phase === 'stopping')) {
        return this.snapshot(entry)
      }
      await this.stopReadiness(entry)
      const executable = await this.ctx.subprocess.resolveExecutable(entry.spec.command)
      const handle = this.ctx.subprocess.spawn({
        argv: [executable, ...entry.spec.args],
        cwd: entry.spec.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.maxOutputBytes },
          stderr: { maxBytes: this.config.maxOutputBytes },
        },
        graceMs: this.config.graceMs,
      })
      entry.handle = handle
      entry.phase = 'running'
      entry.startedAt = Date.now()
      entry.finishedAt = undefined
      entry.outcome = undefined
      entry.error = undefined
      this.startReadiness(entry, handle)
      void handle.done.then(
        (outcome) => { this.settle(entry, handle, outcome) },
        (error: unknown) => { this.fail(entry, handle, error) },
      )
      return this.snapshot(entry)
    })
  }

  /**
   * Stop one task's complete process tree and wait until it is gone.
   * @param id - Configured task identity.
   * @returns State after the serialized stop operation reaches quiescence.
   */
  @Remote('stop')
  stop(id: DevWorkbenchEntryId): Promise<DevWorkbenchEntrySnapshot> {
    return this.enqueue(id, async (entry) => {
      const handle = entry.handle
      if (handle === undefined || (entry.phase !== 'running' && entry.phase !== 'stopping')) {
        return this.snapshot(entry)
      }
      entry.phase = 'stopping'
      await this.stopReadiness(entry)
      handle.terminate()
      await handle.done.catch(() => undefined)
      await handle.waitForExit()
      if (entry.handle === handle) {
        entry.phase = 'stopped'
        entry.finishedAt ??= Date.now()
      }
      return this.snapshot(entry)
    })
  }

  private enqueue(
    id: DevWorkbenchEntryId,
    operation: (entry: EntryRuntime) => Promise<DevWorkbenchEntrySnapshot>,
  ): Promise<DevWorkbenchEntrySnapshot> {
    if (!this.accepting) return Promise.reject(new Error('dev-workbench: service is disposing'))
    const entry = this.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error(`dev-workbench: unknown entry "${id}"`))
    const result = entry.tail.then(() => {
      if (!this.accepting) throw new Error('dev-workbench: service is disposing')
      return operation(entry)
    })
    entry.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private settle(entry: EntryRuntime, handle: SubprocessHandle, outcome: SubprocessOutcome): void {
    if (entry.handle !== handle) return
    entry.readinessController?.abort()
    entry.phase = 'exited'
    entry.finishedAt = Date.now()
    entry.outcome = outcome
  }

  private fail(entry: EntryRuntime, handle: SubprocessHandle, error: unknown): void {
    if (entry.handle !== handle) return
    entry.readinessController?.abort()
    entry.phase = 'failed'
    entry.finishedAt = Date.now()
    entry.error = errorMessage(error)
  }

  private snapshot(entry: EntryRuntime): DevWorkbenchEntrySnapshot {
    const stdout = entry.handle?.collected.stdout?.readFrom(0)
    const stderr = entry.handle?.collected.stderr?.readFrom(0)
    return {
      id: entry.spec.id,
      label: entry.spec.label,
      argv: [entry.spec.command, ...entry.spec.args],
      cwd: entry.spec.cwd,
      views: entry.spec.views,
      phase: entry.phase,
      ...(entry.readiness === undefined ? {} : { readiness: entry.readiness }),
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      ...(entry.outcome === undefined ? {} : {
        outcome: { exitCode: entry.outcome.exitCode, signal: entry.outcome.signal },
      }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      stdoutLossy: stdout?.lossy ?? false,
      stderrLossy: stderr?.lossy ?? false,
      ...(stdout?.spillPath === undefined ? {} : { stdoutSpillPath: stdout.spillPath }),
      ...(stderr?.spillPath === undefined ? {} : { stderrSpillPath: stderr.spillPath }),
    }
  }

  private startReadiness(entry: EntryRuntime, handle: SubprocessHandle): void {
    const policy = entry.spec.readiness
    if (policy === undefined) {
      entry.readiness = undefined
      return
    }
    const controller = new AbortController()
    entry.readiness = { url: policy.url, state: 'checking' }
    entry.readinessController = controller
    const task = this.probeReadiness(entry, handle, policy, controller.signal)
    const tracked = task.finally(() => {
      if (entry.readinessController === controller) entry.readinessController = undefined
      if (entry.readinessTask === tracked) entry.readinessTask = undefined
    })
    entry.readinessTask = tracked
  }

  private async stopReadiness(entry: EntryRuntime): Promise<void> {
    entry.readinessController?.abort()
    await entry.readinessTask
  }

  private async probeReadiness(
    entry: EntryRuntime,
    handle: SubprocessHandle,
    policy: ResolvedReadinessConfig,
    ownerSignal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now()
    while (this.accepting && readinessActive(entry, handle, ownerSignal)) {
      const attemptSignal = AbortSignal.any([
        ownerSignal,
        AbortSignal.timeout(policy.requestTimeoutMs),
      ])
      try {
        const response = await fetch(policy.url, { method: 'GET', redirect: 'manual', signal: attemptSignal })
        await response.body?.cancel()
        if (!readinessActive(entry, handle, ownerSignal)) return
        const checkedAt = Date.now()
        if (policy.acceptedStatusCodes.includes(response.status)) {
          entry.readiness = { url: policy.url, state: 'ready', checkedAt, statusCode: response.status }
          return
        }
        entry.readiness = {
          url: policy.url,
          state: Date.now() - startedAt >= policy.warnAfterMs ? 'delayed' : 'checking',
          checkedAt,
          statusCode: response.status,
          error: `HTTP ${String(response.status)}`,
        }
      } catch (error) {
        if (!readinessActive(entry, handle, ownerSignal)) return
        const checkedAt = Date.now()
        entry.readiness = {
          url: policy.url,
          state: Date.now() - startedAt >= policy.warnAfterMs ? 'delayed' : 'checking',
          checkedAt,
          error: attemptSignal.aborted
            ? `request timed out after ${String(policy.requestTimeoutMs)}ms`
            : errorMessage(error),
        }
      }
      await waitForNextProbe(policy.intervalMs, ownerSignal)
    }
  }
}

function waitForNextProbe(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, intervalMs)
    signal.addEventListener('abort', done, { once: true })
  })
}

export default DevWorkbenchService
