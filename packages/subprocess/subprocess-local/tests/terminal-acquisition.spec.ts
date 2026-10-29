import { Context } from '@deepseek-ai/cordis'
import { SubprocessTerminalCleanupError } from '@deepseek-ai/dsh-subprocess'
import type { IPty } from 'node-pty'
import { expect, it, vi } from 'vitest'
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
    let restoreKill: (() => void) | undefined
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
        const nativeKill = allocated.kill.bind(allocated)
        const retryKill = vi.spyOn(allocated, 'kill').mockImplementation((signal) => {
          try { nativeKill(signal) } finally { deliverExit?.() }
        })
        restoreKill = () => { retryKill.mockRestore() }
        await fiber.dispose()
        expect(retryKill).toHaveBeenCalledWith('SIGTERM')
      } else expect(result.error).toBe(inspectionFailure)
      await fiber.dispose()
      if (delivery !== 'missing') expect({ nativeExitSeen, pidStillExists: processExists(terminal.pid) })
        .toEqual({ nativeExitSeen: true, pidStillExists: false })
    } finally {
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
        await pending
        restoreKill?.()
        restoreExit?.()
        stopExit?.()
        await fiber.dispose()
      }
    }
  })
