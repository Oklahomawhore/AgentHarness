import { Context } from '@deepseek-ai/cordis'
import { SubprocessTerminalCleanupError } from '@deepseek-ai/dsh-subprocess'
import type { IPty } from 'node-pty'
import { expect, it, onTestFinished, vi } from 'vitest'
import { existsSync } from 'node:fs'
import type { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
import * as nodePty from 'node-pty'
import { LocalTerminalHandle } from '../src/terminal.ts'
import { prepareLinuxTerminalScope } from '../src/linux-scope.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'
import LocalSubprocessRuntime from '../src/index.ts'
import { createProcessInspector } from '../src/process-inspector.ts'

const observation = vi.hoisted(() => ({ acquired: (_terminal: IPty): void => {} }))

// Keep native allocation and exit delivery; observe the resource before provider construction can fail.
vi.mock('node-pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-pty')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const terminal = actual.spawn(...args)
    observation.acquired(terminal)
    return terminal
  } }
})

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

it.skipIf(process.platform === 'win32').each(['native', 'delayed', 'missing'] as const)(
  'confirms native PTY cleanup or reports unknown exit after initial inspection fails; callback=%s', async (delivery) => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const runtime = ctx.subprocess as LocalSubprocessRuntime
    const inspector = createProcessInspector()
    const inspectionFailure = Object.assign(new Error('fixture process-table observation is unavailable'), { code: 'EPERM' })
    const snapshot = vi.spyOn(inspector, 'snapshot').mockImplementation(() => { throw inspectionFailure })
    runtime.terminalInspector = inspector
    let terminal: IPty | undefined
    let nativeExitSeen = false
    let stopExit: (() => void) | undefined
    let restoreExit: (() => void) | undefined
    let restoreTermination: (() => void) | undefined
    let deliverExit: (() => void) | undefined
    observation.acquired = (allocated) => {
      terminal = allocated
      const onExit = allocated.onExit
      const listener = onExit(() => { nativeExitSeen = true })
      stopExit = () => { listener.dispose() }
      if (delivery !== 'native') {
        const deferredExit: IPty['onExit'] = (callback) => {
          let active = true
          const subscription = onExit((event) => {
            deliverExit = () => { if (active) callback(event) }
          })
          return { dispose() { active = false; subscription.dispose() } }
        }
        const descriptor = Object.getOwnPropertyDescriptor(allocated, 'onExit')
        Object.defineProperty(allocated, 'onExit', { configurable: true, value: deferredExit })
        restoreExit = () => {
          if (descriptor === undefined) Reflect.deleteProperty(allocated, 'onExit')
          else Object.defineProperty(allocated, 'onExit', descriptor)
        }
      }
    }
    let pending: Promise<unknown> | undefined
    const cleanup = async (): Promise<void> => {
      snapshot.mockRestore()
      observation.acquired = () => {}
      deliverExit?.()
      const allocated = terminal
      try {
        // The native exit observer fences this exact unreaped allocation against PID reuse.
        if (allocated !== undefined && !nativeExitSeen) allocated.kill('SIGKILL')
        if (allocated !== undefined) await vi.waitFor(() => {
          expect(nativeExitSeen).toBe(true)
          expect(processExists(allocated.pid)).toBe(false)
        }, { timeout: 5000, interval: 10 })
      } finally {
        deliverExit?.()
        await pending
        restoreTermination?.()
        restoreExit?.()
        stopExit?.()
        await fiber.dispose()
      }
    }
    onTestFinished(cleanup)
    try {
      let settled = false
      const outcome = runtime.spawnTerminal({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(), rows: 24, cols: 80, graceMs: delivery === 'missing' ? 10 : 5000,
      }).then((value) => { settled = true; return { kind: 'opened' as const, value } },
        (error: unknown) => { settled = true; return { kind: 'failed' as const, error } })
      pending = outcome
      if (terminal === undefined) throw new Error('The provider did not allocate its native PTY')
      if (delivery === 'delayed') {
        const allocated = terminal
        await vi.waitFor(() => {
          expect(nativeExitSeen).toBe(true)
          expect(processExists(allocated.pid)).toBe(false)
          expect(deliverExit).toBeTypeOf('function')
        }, { timeout: 5000, interval: 10 })
        expect(settled).toBe(false)
        deliverExit?.()
      }
      const result = await outcome
      if (result.kind !== 'failed') throw new Error('Initial process inspection unexpectedly succeeded')
      if (delivery === 'missing') {
        expect(result.error).toBeInstanceOf(SubprocessTerminalCleanupError)
        if (!(result.error instanceof SubprocessTerminalCleanupError)) throw new Error('Missing cleanup failure')
        expect(result.error.cause).toBe(inspectionFailure)
        expect(result.error.spawnError).toBe(inspectionFailure)
        expect(result.error.cleanupError).toMatchObject({ message: `terminal cleanup failed; exit unconfirmed for pid: ${terminal.pid}` })
        const allocated = terminal
        await vi.waitFor(() => {
          expect(nativeExitSeen).toBe(true)
          expect(processExists(allocated.pid)).toBe(false)
          expect(deliverExit).toBeTypeOf('function')
        }, { timeout: 5000, interval: 10 })
        // oxlint-disable-next-line typescript/unbound-method -- .call(this) preserves the runtime-owned receiver.
        const terminate = LocalTerminalHandle.prototype.terminate
        const retry = vi.spyOn(LocalTerminalHandle.prototype, 'terminate').mockImplementation(function (this: LocalTerminalHandle) {
          try { return terminate.call(this) } finally { deliverExit?.() }
        })
        restoreTermination = () => { retry.mockRestore() }
        await fiber.dispose()
        expect(retry).toHaveBeenCalled()
      } else expect(result.error).toBe(inspectionFailure)
      await fiber.dispose()
      if (delivery !== 'missing') expect({ nativeExitSeen, pidStillExists: processExists(terminal.pid) })
        .toEqual({ nativeExitSeen: true, pidStillExists: false })
    } finally {
      await cleanup()
    }
  })


it.skipIf(process.platform === 'win32')('reports missing native exit before starting an unconsumed Linux scope observation', async () => {
  const missing = 'Unit dsh.scope could not be found.'
  const query = vi.fn(async () => ({ status: 1, stdout: '', stderr: missing }))
  const runSystemctl = vi.fn<(command: string, args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>>().mockReturnValue({
    pid: 0, output: [null, '', missing], stdout: '', stderr: missing, status: 1, signal: null,
  })
  const spec = { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(), rows: 24, cols: 80, graceMs: 10 }
  const scope = prepareLinuxTerminalScope(spec, {}, {
    // This fixture exercises only the UTF-8 signal calls, not spawnSync's other overloads.
    spawnSync: runSystemctl as unknown as typeof spawnSync, systemctlQuery: query,
  })
  const request = scope.env[SUBPROCESS_RUNNER_ENV]
  let terminal: IPty | undefined
  let handle: LocalTerminalHandle | undefined
  let nativeExitSeen = false
  let deliverExit: (() => void) | undefined
  let stopExit: (() => void) | undefined
  let pending: Promise<unknown> | undefined
  const cleanup = async (): Promise<void> => {
    deliverExit?.()
    try {
      if (terminal !== undefined && !nativeExitSeen) terminal.kill('SIGKILL')
      if (terminal !== undefined) {
        const allocated = terminal
        await vi.waitFor(() => {
          expect(nativeExitSeen).toBe(true)
          expect(processExists(allocated.pid)).toBe(false)
        }, { timeout: 5000, interval: 10 })
        deliverExit?.()
      }
      await pending
      await handle?.terminate()
    } finally {
      stopExit?.()
      scope.cleanup()
    }
  }
  onTestFinished(cleanup)
  try {
    terminal = nodePty.spawn(process.execPath, spec.argv.slice(1), { cwd: spec.cwd, rows: spec.rows, cols: spec.cols })
    const onExit = terminal.onExit
    const observed = onExit(() => { nativeExitSeen = true })
    stopExit = () => { observed.dispose() }
    const withheld: IPty['onExit'] = (callback) => {
      let active = true
      const listener = onExit((event) => { deliverExit = () => { if (active) callback(event) } })
      return { dispose() { active = false; listener.dispose() } }
    }
    Object.defineProperty(terminal, 'onExit', { configurable: true, value: withheld })
    const allocated = terminal
    const owner = scope.bindOwner({ running: () => handle?.running ?? true,
      signal: (signal) => { try { allocated.kill(signal) } catch { /* The actual PTY has already exited. */ } } })
    const inspector = createProcessInspector()
    const failure = new Error('Initial process-table observation is unavailable')
    vi.spyOn(inspector, 'snapshot').mockImplementation(() => { throw failure })
    handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs, 'linux', owner, scope.resolveOutcome)
    expect(() => { handle?.captureRootIdentity() }).toThrow(failure)
    let result: unknown
    pending = handle.terminate().then(() => { result = 'unexpected success' }, (error: unknown) => { result = error })
    await vi.waitFor(() => {
      expect(nativeExitSeen).toBe(true)
      expect(processExists(allocated.pid)).toBe(false)
      expect(deliverExit).toBeTypeOf('function')
    }, { timeout: 5000, interval: 10 })
    await vi.waitFor(() => { expect(result).toBeDefined() }, { timeout: 1000, interval: 10 })
    expect(result).toMatchObject({ message: `terminal cleanup failed; exit unconfirmed for pid: ${terminal.pid}` })
    expect(query).not.toHaveBeenCalled()
    if (request === undefined) throw new Error('Missing actual Linux launch request')
    expect(existsSync(request)).toBe(true)
  } finally {
    await cleanup()
  }
})
