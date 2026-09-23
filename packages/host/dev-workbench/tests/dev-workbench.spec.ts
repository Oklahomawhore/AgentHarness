import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import DevWorkbenchService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { DevWorkbenchEntryId } from '../src/types.ts'

const contexts: Context[] = []
const servers: Server[] = []
const id = (value: string): DevWorkbenchEntryId => value as DevWorkbenchEntryId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
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

  it('single-flights repeated starts and waits for process-tree stop', async () => {
    const { service } = await bench(['-e', 'setInterval(() => {}, 1000)'])
    const [first, second] = await Promise.all([
      service.start(id('fixture')),
      service.start(id('fixture')),
    ])
    expect(first.pid).toBeGreaterThan(0)
    expect(second.pid).toBe(first.pid)

    const stopped = await service.stop(id('fixture'))
    expect(stopped.phase).toBe('stopped')
    expect(stopped.pid).toBeUndefined()
    expect(await service.stop(id('fixture'))).toMatchObject({ phase: 'stopped' })
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
    const { service } = await bench(['-e', 'setInterval(() => {}, 1000)'], {
      url: `http://127.0.0.1:${String(address.port)}/pending`,
      acceptedStatusCodes: [200],
      intervalMs: 10,
      requestTimeoutMs: 10_000,
      warnAfterMs: 10_000,
    })

    await service.start(id('fixture'))
    await startedRequest
    await expect(service.stop(id('fixture'))).resolves.toMatchObject({ phase: 'stopped' })
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
