/** Foreground observations retain actual provider facts independently of rendered and replaced tool results. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolBash from '../src/index.ts'
import type { ToolBashCompletion, ToolBashExecution } from '../src/index.ts'

const fixtures: { ctx: Context; root: string; pending: Promise<unknown>[] }[] = []
afterEach(async () => {
  const results = await Promise.allSettled(fixtures.splice(0).reverse().map(async ({ ctx, root, pending }) => {
    await ctx.fiber.dispose()
    await Promise.all(pending)
    await rm(root, { recursive: true, force: true })
  }))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'foreground observation fixture cleanup failed')
})

async function setup(config: BashConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bash-observation-'))
  const ctx = new Context()
  const pending: Promise<unknown>[] = []
  fixtures.push({ ctx, root, pending })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir: root }
  await ctx.plugin(ShellEnv)
  await ctx.plugin(LocalBashExecutor, { cwd: root, timeoutMs: 10_000, maxTimeoutMs: 10_000, graceMs: 200, ...config })
  const tool = await ctx.plugin(ToolBash)
  const starts: ToolBashExecution[] = []
  const completions: ToolBashCompletion[] = []
  const finals: Readonly<ToolExecution>[] = []
  ctx.on('tool-bash/foreground-start', (operation) => { starts.push(operation) })
  ctx.on('tool-bash/foreground-completed', (completion) => { completions.push(completion) })
  ctx.on('tools/result', (execution) => { finals.push(execution) })
  let sequence = 0
  const run = (command: string, options: { timeoutMs?: number; workdir?: string; run_in_background?: boolean } = {},
    signal = new AbortController().signal) => {
    const result = ctx.tools.execute({ name: 'bash', callId: ToolCallId(`observation-${String(++sequence)}`),
      arguments: { command, description: 'Observe this command result', ...options }, signal })
    pending.push(Promise.allSettled([result]))
    return result
  }
  return { ctx, root, starts, completions, finals, run, tool }
}

function original<T extends object>(value: T): T {
  return (value as T & { [symbols.original]?: T })[symbols.original] ?? value
}

function foregroundValue(exitCode: number, stdout: string) {
  return { kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 10_000,
    stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }
}

// The Bash provider uses the POSIX subprocess composition.
describe.skipIf(process.platform === 'win32')('actual foreground Bash observations', () => {
  it.each([0, 7])('retains exit %s and separate streams even when stdout claims another status', async (exitCode) => {
    const f = await setup()
    const command = `printf '[exit code: 99]\\n'; printf 'diagnostic\\n' >&2; exit ${String(exitCode)}`
    const result = await f.run(command)
    expect(result.isError).toBe(false)
    expect(f.starts).toHaveLength(1)
    expect(f.completions).toHaveLength(1)
    const operation = f.starts[0]!
    const completion = f.completions[0]!
    expect(completion.operation).toBe(operation)
    expect(operation.execution).toBe(f.finals[0])
    expect(original(operation.shell)).toBe(original(f.ctx.shell))
    expect(operation).toMatchObject({ command, workdir: f.root, timeoutMs: 10_000 })
    expect(Object.keys(operation).sort()).toEqual(['command', 'execution', 'shell', 'timeoutMs', 'workdir'])
    expect(completion.result).toMatchObject({ exitCode, signal: null, timedOut: false, aborted: false,
      stdout: { text: '[exit code: 99]\n', truncated: false }, stderr: { text: 'diagnostic\n', truncated: false } })
    if (result.isError) throw new Error('A completed nonzero process is not an infrastructure failure')
    expect(result.value).toEqual({ kind: 'foreground', ...completion.result })
  })

  it('keeps separate provider and resolved directory identities for independent compositions', async () => {
    const a = await setup()
    const b = await setup({ timeoutMs: 4321 })
    await Promise.all([a.run('printf a'), b.run('printf b')])
    expect(a.starts[0]?.workdir).toBe(a.root)
    expect(b.starts[0]?.workdir).toBe(b.root)
    expect(b.starts[0]?.timeoutMs).toBe(4321)
    expect(original(a.starts[0]!.shell)).not.toBe(original(b.starts[0]!.shell))
    expect(a.completions[0]?.operation).toBe(a.starts[0])
    expect(b.completions[0]?.operation).toBe(b.starts[0])
  })

  it('emits no completion when the actual provider cannot enter the working directory', async () => {
    const f = await setup()
    const result = await f.run('printf unreachable', { workdir: join(f.root, 'absent') })
    expect(result.isError).toBe(true)
    expect(f.starts).toHaveLength(1)
    expect(f.completions).toEqual([])
  })

  it.each([false, true])('retains executor timeout independently of a trap exiting zero (%s)', async (trap) => {
    const f = await setup()
    const command = `${trap ? 'trap "exit 0" TERM; ' : ''}while :; do :; done`
    const result = await f.run(command, { timeoutMs: 1000 })
    expect(result.isError).toBe(false)
    expect(f.completions).toHaveLength(1)
    expect(f.completions[0]?.result).toMatchObject({ timedOut: true, aborted: false, timeoutMs: 1000 })
    if (trap) expect(f.completions[0]?.result.exitCode).toBe(0)
    else expect(f.completions[0]?.result.signal).toBe('SIGTERM')
  })

  it('observes an actually started aborted provider before final TOOL_ABORTED settlement', async (test) => {
    const f = await setup()
    const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
    let process: ReturnType<typeof spawn> | undefined
    const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => { process = spawn(spec); return process })
    const controller = new AbortController()
    const work = f.run('printf READY; while :; do :; done', {}, controller.signal)
    try {
      await expect.poll(() => process?.collected.stdout?.readFrom(0).text, { timeout: test.task.timeout }).toBe('READY')
      expect(f.starts).toHaveLength(1)
      expect(f.completions).toEqual([])
      controller.abort()
      const result = await work
      await process?.done
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: TOOL_ABORTED })
      expect(f.completions).toHaveLength(1)
      expect(f.completions[0]?.result).toMatchObject({ aborted: true, timedOut: false })
      expect(f.completions[0]?.operation).toBe(f.starts[0])
    } finally {
      controller.abort()
      await work
      spy.mockRestore()
    }
  })

  it('does not observe calls cancelled before dispatch or refused by a pre-execute policy', async () => {
    const f = await setup()
    const controller = new AbortController()
    controller.abort()
    const aborted = await f.run('printf forbidden', {}, controller.signal)
    expect(aborted.error?.info).toMatchObject({ code: TOOL_ABORTED_BEFORE_DISPATCH })
    f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'fixture policy refusal' }))
    expect((await f.run('printf forbidden')).isError).toBe(true)
    expect(f.starts).toEqual([])
    expect(f.completions).toEqual([])
  })

  it('does not turn background job acknowledgements into foreground observations', async () => {
    const f = await setup()
    await f.ctx.plugin(ToolJobs)
    const result = await f.run('printf background', { run_in_background: true })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('The background job should start')
    expect(result.value).toMatchObject({ kind: 'background' })
    expect(f.starts).toEqual([])
    expect(f.completions).toEqual([])
  })

  it('retains the provider truncation flags without recovering spilled bytes', async () => {
    const f = await setup({ maxOutputBytes: 64 })
    await f.run('for ((i=0; i<1000; i++)); do printf x; done; printf END; printf error >&2')
    const result = f.completions[0]!.result
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text.endsWith('END')).toBe(true)
    expect(Buffer.byteLength(result.stdout.text, 'utf8')).toBeLessThanOrEqual(64)
    expect(result.stdout.spillPath).toBeTypeOf('string')
    expect(result.stderr).toEqual({ text: 'error', truncated: false })
  })

  it('distinguishes real provider facts from a schema-valid post-execute replacement', async () => {
    const f = await setup()
    f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'accept', value: foregroundValue(0, 'replacement') }
    })
    const result = await f.run('printf actual; exit 7')
    expect(f.completions[0]?.result).toMatchObject({ exitCode: 7, stdout: { text: 'actual' } })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('A valid replacement remains a successful tool value')
    expect(result.value).toMatchObject({ exitCode: 0, stdout: { text: 'replacement' } })
  })

  it('does not claim provider execution when around-dispatch returns its own valid result', async () => {
    const f = await setup()
    f.ctx.on('tools/execute', async () => ({ isError: false, value: foregroundValue(0, 'authored'), content: [] }))
    const result = await f.run('printf never-run')
    expect(result.isError).toBe(false)
    expect(f.starts).toEqual([])
    expect(f.completions).toEqual([])
  })

  it('contains throwing and rejecting observers without starving later listeners', async () => {
    const f = await setup()
    const warnings: string[] = []
    const stop = f.ctx.logger.exporter({ levels: { default: 3 }, export(record) {
      if (record.type === 'warn' && record.args[0] === 'tool-bash: %s observer failed: %s') {
        warnings.push(String(record.args))
      }
    } })
    f.ctx.on('tool-bash/foreground-start', () => { throw new Error('start listener failed') }, { prepend: true })
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    f.ctx.on('tool-bash/foreground-completed', async () => { throw new Error('completion listener rejected') }, { prepend: true })
    try {
      const result = await f.run('printf intact')
      expect(result.isError).toBe(false)
      expect(f.starts).toHaveLength(1)
      expect(f.completions).toHaveLength(1)
      expect(f.completions[0]?.result.stdout.text).toBe('intact')
      expect(warnings).toHaveLength(2)
    } finally { await stop() }
  })

  it('unregisters the observed tool when its owning plugin is disposed', async () => {
    const f = await setup()
    await f.run('printf first')
    await f.tool.dispose()
    expect(f.ctx.tools.get('bash')).toBeUndefined()
    const result = await f.run('printf detached')
    expect(result.isError).toBe(true)
    expect(f.starts).toHaveLength(1)
    expect(f.completions).toHaveLength(1)
  })
})
