/** Command readiness, complete stream output, and cancellation through real Node streams. */
import { Context } from '@deepseek-ai/cordis'
import { PassThrough, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Command from '../src/command.ts'
import { callClaudeScopeHook, ClaudeScopeCommandFailure } from '../src/transport.ts'

vi.mock('../src/transport.ts', async (original) => {
  const actual = await original<typeof import('../src/transport.ts')>()
  return { ...actual, callClaudeScopeHook: vi.fn() }
})

const cleanups: (() => Promise<void>)[] = []
const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: 'Complete 中文🙂 context' } }
const config = { descriptorPath: resolve('unused-command-descriptor.json'),
  maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000 } satisfies Command.Config

afterEach(async () => {
  try { while (cleanups.length > 0) await cleanups.pop()!() }
  finally { vi.restoreAllMocks(); vi.useRealTimers() }
})

async function fixture(overrides: Partial<Command.Config> = {}, write?: (done: (error?: Error | null) => void) => void,
  highWaterMark = 16_384) {
  const ctx = new Context()
  const input = new PassThrough()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const sink = new Writable({ highWaterMark, write(chunk: Buffer, _encoding, done) {
    stdout.push(Buffer.from(chunk))
    if (write === undefined) done(); else write(done)
  } })
  const diagnostic = new Writable({ write(chunk: Buffer, _encoding, done) { stderr.push(Buffer.from(chunk)); done() } })
  const saved = ['stdin', 'stdout', 'stderr'].map(name => [name, Object.getOwnPropertyDescriptor(process, name)] as const)
  cleanups.push(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(process, name)
        else Object.defineProperty(process, name, descriptor)
      }
      const streams = [input, sink, diagnostic]
      const closed = streams.map(stream => stream.closed ? Promise.resolve()
        : new Promise<void>((resolve) => { stream.once('close', resolve) }))
      for (const stream of streams) stream.destroy()
      await Promise.all(closed)
    }
  })
  Object.defineProperties(process, { stdin: { configurable: true, value: input },
    stdout: { configurable: true, value: sink }, stderr: { configurable: true, value: diagnostic } })
  let start: (() => void) | undefined
  ctx.provide('appReady', { onReady(listener) { start = listener; return () => { start = undefined } } })
  const exited = Promise.withResolvers<number>()
  const exit = vi.fn((code: number) => { exited.resolve(code) })
  ctx.provide('appExit', exit)
  const reading = Promise.withResolvers<undefined>()
  const iterate = input[Symbol.asyncIterator].bind(input)
  vi.spyOn(input, Symbol.asyncIterator).mockImplementation(() => { reading.resolve(undefined); return iterate() })
  vi.mocked(callClaudeScopeHook).mockReset().mockResolvedValue({ output, receipt: { status: 'projected', projectionId: 'private-host-receipt' } })
  await ctx.plugin(Command, { ...config, ...overrides })
  return { ctx, input, sink, exit, exited: exited.promise, reading: reading.promise,
    start: () => { if (start === undefined) throw new Error('Command has no readiness listener'); start() },
    stdout: () => Buffer.concat(stdout).toString('utf8'), stderr: () => Buffer.concat(stderr).toString('utf8') }
}

it('requires an absolute descriptor and launcher-owned readiness and exit services', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  expect(() => { Command.apply(ctx, { ...config, descriptorPath: 'relative.json' }) }).toThrow('must be absolute')
  expect(() => { Command.apply(ctx, config) }).toThrow('requires the dsh application lifecycle')
})

it('waits for readiness and complete stdin EOF, then writes only the complete Hook output', async () => {
  const f = await fixture()
  f.input.write('{"hook_event_name":"UserPromptSubmit",')
  expect(callClaudeScopeHook).not.toHaveBeenCalled()
  f.start()
  await f.reading
  expect(callClaudeScopeHook).not.toHaveBeenCalled()
  f.input.end('"session_id":"external-main"}')
  expect(await f.exited).toBe(0)
  expect(callClaudeScopeHook).toHaveBeenCalledWith(config,
    { hook_event_name: 'UserPromptSubmit', session_id: 'external-main' }, expect.any(AbortSignal))
  expect(f.stdout()).toBe(JSON.stringify(output) + '\n')
  expect(f.stdout()).not.toContain('private-host-receipt')
  expect(f.stderr()).toBe('')
})

it.each([
  { input: '{"PRIVATE_INPUT":', limit: 4096, code: 'input-invalid' },
  { input: '"' + '界'.repeat(8) + '"', limit: 25, code: 'input-too-large' },
])('rejects complete stdin with $code before calling the Host', async ({ input, limit, code }) => {
  const f = await fixture({ maxRequestBytes: limit })
  f.input.end(input); f.start()
  expect(await f.exited).toBe(1)
  expect(callClaudeScopeHook).not.toHaveBeenCalled()
  expect(f.stdout()).toBe('')
  expect(f.stderr()).toBe(JSON.stringify({ claudeScopeError: code }) + '\n')
})

it.each([new ClaudeScopeCommandFailure('rpc-rejected'), new Error('PRIVATE_CAPABILITY_TOKEN')])(
  'writes a classified diagnostic without leaking the Host failure: %s', async (failure) => {
    const f = await fixture()
    vi.mocked(callClaudeScopeHook).mockRejectedValueOnce(failure)
    f.input.end('{}'); f.start()
    expect(await f.exited).toBe(1)
    expect(f.stdout()).toBe('')
    expect(f.stderr()).toBe(JSON.stringify({ claudeScopeError: failure instanceof ClaudeScopeCommandFailure ? failure.code : 'transport-failed' }) + '\n')
  },
)

it('rejects an oversized complete output before writing its first stdout byte', async () => {
  const f = await fixture({ maxResponseBytes: Buffer.byteLength(JSON.stringify(output)) })
  f.input.end('{}'); f.start()
  expect(await f.exited).toBe(1)
  expect(f.stdout()).toBe('')
  expect(f.stderr()).toBe('{"claudeScopeError":"output-too-large"}\n')
})

it.each([1, 16_384])('waits for a stdout write with highWaterMark=%i to finish before reporting success', async (highWaterMark) => {
  const writing = Promise.withResolvers<undefined>()
  let complete: (() => void) | undefined
  const f = await fixture({}, (done) => { complete = done; writing.resolve(undefined) }, highWaterMark)
  cleanups.push(async () => { complete?.() })
  f.input.end('{}'); f.start()
  await writing.promise
  expect(f.sink.writableLength >= f.sink.writableHighWaterMark).toBe(highWaterMark === 1)
  expect(f.exit).not.toHaveBeenCalled()
  if (complete === undefined) throw new Error('No stdout write is pending')
  complete()
  expect(await f.exited).toBe(0)
  expect(f.stdout()).toBe(JSON.stringify(output) + '\n')
})

it('contains a real stdout write failure without exposing the stream error', async () => {
  const f = await fixture({}, (done) => { done(new Error('PRIVATE_OUTPUT_FAILURE')) })
  f.input.end('{}'); f.start()
  expect(await f.exited).toBe(1)
  expect(f.sink.destroyed).toBe(true)
  expect(f.stderr()).toBe('{"claudeScopeError":"transport-failed"}\n')
})

it.each([1, 16_384])('retains its deadline until a pending stdout write with highWaterMark=%i settles', async (highWaterMark) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const writing = Promise.withResolvers<undefined>()
  let complete: (() => void) | undefined
  const f = await fixture({}, (done) => { complete = done; writing.resolve(undefined) }, highWaterMark)
  cleanups.push(async () => { complete?.() })
  f.input.end('{}'); f.start(); await writing.promise
  expect(f.sink.writableLength >= f.sink.writableHighWaterMark).toBe(highWaterMark === 1)
  await vi.advanceTimersByTimeAsync(config.timeoutMs)
  expect(await f.exited).toBe(1)
  expect(f.sink.destroyed).toBe(true)
  expect(f.stderr()).toBe('{"claudeScopeError":"request-timeout"}\n')
})

it('expires while stdin is still open and settles its reader without contacting the Host', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = await fixture()
  f.start(); await f.reading
  await vi.advanceTimersByTimeAsync(config.timeoutMs)
  expect(await f.exited).toBe(1)
  expect(f.input.destroyed).toBe(true)
  expect(callClaudeScopeHook).not.toHaveBeenCalled()
  expect(f.stdout()).toBe('')
  expect(f.stderr()).toBe('{"claudeScopeError":"request-timeout"}\n')
})

it('aborts and awaits an in-flight Host request during disposal without reporting an application exit', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  cleanups.push(async () => { released.resolve(undefined) })
  vi.mocked(callClaudeScopeHook).mockImplementationOnce(async (_config, _input, signal) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true }) })
    await released.promise
    throw signal.reason
  })
  f.input.end('{}'); f.start(); await entered.promise
  let settled = false
  const stopping = f.ctx.fiber.dispose().then(() => { settled = true })
  try {
    await aborted.promise
    expect(settled).toBe(false)
    released.resolve(undefined)
    await stopping
    expect(f.exit).not.toHaveBeenCalled()
    expect(f.stdout()).toBe('')
    expect(f.stderr()).toBe('')
  } finally { released.resolve(undefined); await stopping }
})

it('removes its readiness listener when disposed before startup', async () => {
  const f = await fixture()
  await f.ctx.fiber.dispose()
  expect(f.start).toThrow('no readiness listener')
  expect(callClaudeScopeHook).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
})
