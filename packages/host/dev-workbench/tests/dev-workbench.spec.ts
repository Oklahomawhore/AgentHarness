import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, onTestFailed, onTestFinished, TestRunner, vi } from 'vitest'
import DevWorkbenchService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { DevWorkbenchEntryId } from '../src/types.ts'

const contexts: Context[] = []
const servers: Server[] = []
const id = (value: string): DevWorkbenchEntryId => value as DevWorkbenchEntryId
let cleanupPhase = 'not-started'

afterEach(async () => {
  cleanupPhase = 'disposing-contexts'
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  cleanupPhase = 'closing-servers'
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
  cleanupPhase = 'complete'
})

function config(args: string[], readiness?: Config['entries'][string]['readiness']): Config {
  return {
    entries: {
      fixture: {
        label: 'Fixture',
        cwd: process.cwd(),
        command: process.execPath,
        args,
        views: [{ id: 'debug', label: 'Debug', url: 'http://127.0.0.1:3001/local-debug' }],
        ...readiness === undefined ? {} : { readiness },
      },
    },
    maxOutputBytes: 4096,
    graceMs: 100,
  }
}

async function bench(
  args: string[],
  readiness?: Config['entries'][string]['readiness'],
): Promise<{ ctx: Context; service: DevWorkbenchService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(DevWorkbenchService, config(args, readiness))
  return { ctx, service: ctx.devWorkbench }
}

async function waitForPhase(service: DevWorkbenchService, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.list().entries[0]?.phase === phase) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`fixture did not reach ${phase}`)
}

async function waitForReadiness(service: DevWorkbenchService, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.list().entries[0]?.readiness?.state === state) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`fixture did not reach readiness ${state}`)
}

describe('DevWorkbenchService', () => {
  it.each(['intervalMs', 'requestTimeoutMs'] as const)('rejects readiness %s that Node would clamp to one millisecond', async (field) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    const load = async (): Promise<void> => {
      await ctx.plugin(DevWorkbenchService, config(['-e', ''], {
        url: 'http://127.0.0.1:1/never-requested', acceptedStatusCodes: [200],
        intervalMs: 10, requestTimeoutMs: 100, warnAfterMs: 1000, [field]: 2_147_483_648,
      }))
    }
    await expect(load()).rejects.toThrow(field)
  })

  it('accepts the maximum timer delay without limiting the elapsed warning threshold to the timer range', async () => {
    const { service } = await bench(['-e', ''], {
      url: 'http://127.0.0.1:1/never-requested', acceptedStatusCodes: [200],
      intervalMs: 2_147_483_647, requestTimeoutMs: 2_147_483_647, warnAfterMs: Number.MAX_SAFE_INTEGER,
    })
    expect(service.list().entries).toMatchObject([{ phase: 'idle' }])
  })

  it('rejects a grace period outside the subprocess timer range before accepting task controls', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    const load = async (): Promise<void> => {
      await ctx.plugin(DevWorkbenchService, { ...config([]), graceMs: 2_147_483_648 })
    }
    await expect(load()).rejects.toThrow('graceMs')
  })

  it('publishes direct list/start/stop Remote methods', async () => {
    const { service } = await bench(['-e', ''])
    expect(service.typertRemote).toMatchObject({ serviceKey: 'devWorkbench', namespace: 'devWorkbench' })
    expect(remoteMethods(service)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'start', invocation: { kind: 'direct' } },
      { method: 'stop', invocation: { kind: 'direct' } },
    ])
  })

  it('starts an argv without a shell and retains bounded output after exit', async () => {
    const { service } = await bench(['-e', "console.log('ready'); console.error('diagnostic')"])
    const started = await service.start(id('fixture'))
    expect(started).toMatchObject({
      phase: 'running',
      argv: [process.execPath, '-e', "console.log('ready'); console.error('diagnostic')"],
    })
    expect(started.views).toEqual([
      { id: 'debug', label: 'Debug', url: 'http://127.0.0.1:3001/local-debug' },
    ])

    await waitForPhase(service, 'exited')
    const settled = service.list().entries[0]
    expect(settled).toMatchObject({
      phase: 'exited',
      outcome: { exitCode: 0, signal: null },
      stdout: 'ready\n',
      stderr: 'diagnostic\n',
    })
    expect(settled?.pid).toBeUndefined()
  })

  it.each(['stop', 'restart', 'unload'] as const)('quiesces surviving child work on %s after the task leader exits', async (action) => {
    const child = `const server = require('node:http').createServer((_request, response) => response.end('owned child'));
      server.listen(0, '127.0.0.1', () => process.send(server.address().port));`
    // Windows detachment avoids Node's parent-exit Job; POSIX children retain the managed PGID.
    const leader = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}],
      { detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', port => { console.log(port); child.disconnect(); process.exit(0) });`
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    const plugin = await ctx.plugin(DevWorkbenchService, config(['-e', leader]))
    const service = ctx.devWorkbench
    const handles: SubprocessHandle[] = []
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const observed = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      handles.push(handle)
      return handle
    })
    try {
      await service.start(id('fixture'))
      await expect.poll(() => service.list().entries[0]?.phase, { timeout: TestRunner.getCurrentTest()!.timeout }).toBe('exited')
      const port = Number(service.list().entries[0]?.stdout.trim())
      expect(Number.isInteger(port) && port > 0).toBe(true)
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(2000) })
      expect(await response.text()).toBe('owned child')
      const original = handles[0]
      if (original === undefined) throw new Error('Missing actual managed subprocess handle')
      if (action === 'unload') {
        await plugin.dispose()
        expect(ctx.get('subprocess') !== undefined).toBe(true)
      } else if (action === 'restart') {
        await service.start(id('fixture'))
        expect(handles).toHaveLength(2)
      } else await service.stop(id('fixture'))
      expect(await original.waitForExit(AbortSignal.timeout(1000))).toBe(true)
      await expect(fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    } finally {
      observed.mockRestore()
    }
  })

  it('single-flights repeated starts and waits for process-tree stop', async () => {
    const { ctx, service } = await bench(['-e', "console.log('started'); setInterval(() => {}, 1000)"])
    const subprocess = ctx.subprocess
    const spawn = subprocess.spawn.bind(subprocess)
    const exitObserved = Promise.withResolvers<boolean>()
    const releaseExit = Promise.withResolvers<undefined>()
    const spawned = vi.spyOn(subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      return {
        ...handle,
        async waitForExit(signal) {
          const empty = await handle.waitForExit(signal)
          exitObserved.resolve(empty)
          await releaseExit.promise
          return empty
        },
      }
    })
    try {
      const [first, second] = await Promise.all([
        service.start(id('fixture')),
        service.start(id('fixture')),
      ])
      expect(spawned).toHaveBeenCalledTimes(1)
      expect(first.phase).toBe('running')
      expect(second).toEqual(first)
      await expect.poll(() => service.list().entries[0]?.stdout, {
        timeout: TestRunner.getCurrentTest()!.timeout,
      }).toBe('started\n')

      let returned = false
      const stopping = service.stop(id('fixture')).then((snapshot) => {
        returned = true
        return snapshot
      })
      expect(await Promise.race([
        exitObserved.promise.then(() => 'range-exit-observed'),
        stopping.then(() => 'stop-returned'),
      ])).toBe('range-exit-observed')
      expect(await exitObserved.promise).toBe(true)
      expect(returned).toBe(false)
      releaseExit.resolve(undefined)
      const stopped = await stopping
      expect(stopped.phase).toBe('stopped')
      expect(stopped.outcome).toBeDefined()
      expect(stopped.pid).toBeUndefined()
      expect(await service.stop(id('fixture'))).toMatchObject({ phase: 'stopped' })
      expect(spawned).toHaveBeenCalledTimes(1)
    } finally {
      releaseExit.resolve(undefined)
      spawned.mockRestore()
    }
  })

  it('retains a startup failure without inventing an outcome and waits for its managed range', async () => {
    const { ctx, service } = await bench([])
    const done = Promise.withResolvers<SubprocessOutcome>()
    const empty = Promise.withResolvers<boolean>()
    const observing = Promise.withResolvers<undefined>()
    const failure = new Error('subprocess terminated before target start')
    const spawned = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      stdin: undefined, stdout: undefined, stderr: undefined, collected: {}, done: done.promise,
      terminate() { done.reject(failure) },
      waitForExit() {
        observing.resolve(undefined)
        return empty.promise
      },
    })
    try {
      await service.start(id('fixture'))
      const stopping = service.stop(id('fixture'))
      await observing.promise
      expect(service.list().entries[0]).toMatchObject({ phase: 'failed', error: failure.message })
      empty.resolve(true)
      const stopped = await stopping
      expect(stopped).toMatchObject({ phase: 'stopped', error: failure.message })
      expect(stopped.outcome).toBeUndefined()
    } finally {
      empty.resolve(true)
      spawned.mockRestore()
    }
  })

  it('reports HTTP readiness independently from a live process', async () => {
    let ready = false
    const server = createServer((_request, response) => {
      response.writeHead(ready ? 200 : 503).end()
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
    const { service } = await bench(['-e', 'setInterval(() => {}, 1000)'], {
      url: `http://127.0.0.1:${String(address.port)}/ready`,
      acceptedStatusCodes: [200],
      intervalMs: 10,
      requestTimeoutMs: 100,
      warnAfterMs: 20,
    })

    const started = await service.start(id('fixture'))
    expect(started).toMatchObject({ phase: 'running', readiness: { state: 'checking' } })
    await waitForReadiness(service, 'delayed')
    expect(service.list().entries[0]).toMatchObject({
      phase: 'running',
      readiness: { state: 'delayed', statusCode: 503, error: 'HTTP 503' },
    })

    ready = true
    await waitForReadiness(service, 'ready')
    expect(service.list().entries[0]).toMatchObject({
      phase: 'running',
      readiness: { state: 'ready', statusCode: 200 },
    })
    await service.stop(id('fixture'))
  })

  it('aborts an in-flight readiness request before stopping the process tree', async () => {
    let stage = 'starting-server'
    cleanupPhase = 'not-started'
    const processes: (() => unknown)[] = []
    const restore: (() => void)[] = []
    onTestFailed(() => { console.error('Dev workbench readiness lifecycle', JSON.stringify({ stage, cleanupPhase,
      processes: processes.map(snapshot => snapshot()) })) })
    onTestFinished(() => { for (const undo of restore.reverse()) undo() })
    let requestStarted!: () => void
    const startedRequest = new Promise<void>((resolve) => { requestStarted = resolve })
    const server = createServer(() => { requestStarted() })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
    stage = 'creating-workbench'
    const { ctx, service } = await bench(['-e', 'setInterval(() => {}, 1000)'], {
      url: `http://127.0.0.1:${String(address.port)}/pending`,
      acceptedStatusCodes: [200],
      intervalMs: 10,
      requestTimeoutMs: 10_000,
      warnAfterMs: 10_000,
    })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const observed = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      // oxlint-disable-next-line typescript/unbound-method -- invoked with .call(handle) and restored exactly.
      const originalWait = handle.waitForExit
      // oxlint-disable-next-line typescript/unbound-method -- invoked with .call(handle) and restored exactly.
      const originalTerminate = handle.terminate
      let terminateCalls = 0
      const waiting = vi.fn<typeof handle.waitForExit>(signal => originalWait.call(handle, signal))
      handle.waitForExit = waiting
      handle.terminate = () => { terminateCalls += 1; originalTerminate.call(handle) }
      restore.push(() => { handle.waitForExit = originalWait; handle.terminate = originalTerminate })
      let done: unknown = 'pending'
      void handle.done.then((outcome) => { done = outcome }, (error: unknown) => { done = { error: String(error) } })
      processes.push(() => ({ done, terminateCalls, rangeCalls: waiting.mock.calls.length,
        rangeResults: waiting.mock.settledResults.map(result => result.type), signalAborted: spec.signal?.aborted }))
      return handle
    })
    restore.push(() => { observed.mockRestore() })

    stage = 'starting-process'
    await service.start(id('fixture'))
    stage = 'waiting-for-readiness-request'
    await startedRequest
    stage = 'stopping-process'
    await expect(service.stop(id('fixture'))).resolves.toMatchObject({ phase: 'stopped' })
    stage = 'complete'
  })

  it('fails loud on unknown entries and invalid self-contained config', async () => {
    const { service } = await bench(['-e', ''])
    await expect(service.start(id('missing'))).rejects.toThrow('unknown entry')

    const badCwd = new Context()
    contexts.push(badCwd)
    expect(() => new DevWorkbenchService(badCwd, {
      ...config([]), entries: { bad: { label: 'Bad', cwd: '.', command: 'node' } },
    })).toThrow('cwd must be absolute')

    const badStatuses = new Context()
    contexts.push(badStatuses)
    expect(() => new DevWorkbenchService(badStatuses, {
      ...config([]),
      entries: {
        bad: {
          label: 'Bad',
          cwd: process.cwd(),
          command: 'node',
          readiness: {
            url: 'http://127.0.0.1:3001/',
            acceptedStatusCodes: [],
            intervalMs: 1,
            requestTimeoutMs: 1,
            warnAfterMs: 1,
          },
        },
      },
    })).toThrow('acceptedStatusCodes')

    const badUrl = new Context()
    contexts.push(badUrl)
    expect(() => new DevWorkbenchService(badUrl, {
      ...config([]),
      entries: {
        bad: {
          label: 'Bad',
          cwd: process.cwd(),
          command: 'node',
          readiness: {
            url: 'http://user:secret@127.0.0.1:3001/',
            acceptedStatusCodes: [200],
            intervalMs: 1,
            requestTimeoutMs: 1,
            warnAfterMs: 1,
          },
        },
      },
    })).toThrow('must not contain credentials')
  })
})
