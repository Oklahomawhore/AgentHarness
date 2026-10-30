/** Private local capabilities use the real Connection token and cookie verifier. */
import { Context } from '@deepseek-ai/cordis'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import {
  authenticateLocalConnection, LocalConnectionAccessError, publishLocalConnectionDescriptor,
} from '../src/local-access.ts'
import type { LocalConnectionDescriptor } from '../src/local-access.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const boundary = vi.hoisted(() => ({
  beforeLstat: undefined as ((path: string) => Promise<void>) | undefined,
  afterLstat: undefined as ((path: string) => Promise<void>) | undefined,
  afterRename: undefined as ((source: string, destination: string) => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (typeof args[0] === 'string') await boundary.beforeLstat?.(args[0])
      const value = await actual.lstat(...args)
      if (typeof args[0] === 'string') await boundary.afterLstat?.(args[0])
      return value
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args)
      if (typeof args[0] === 'string' && typeof args[1] === 'string') await boundary.afterRename?.(args[0], args[1])
    },
  }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  boundary.beforeLstat = undefined
  boundary.afterLstat = undefined
  boundary.afterRename = undefined
  vi.restoreAllMocks()
  if (failures.length !== 0) throw new AggregateError(failures, 'local capability fixture cleanup failed')
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'connection-local-access-'))
  await chmod(directory, 0o700)
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const descriptorPath = join(directory, 'connection.json')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  provideBrowserCredentials(ctx)
  const connection = ctx.plugin({ inject: [...inject], apply })
  await connection.await()
  const received: string[] = []
  let redirect: string | undefined
  const server = createServer((request, response) => {
    received.push(request.url ?? '')
    if (request.url?.startsWith('/?token=') === true) {
      ctx.connection.authorizeIndex(request, {
        writeHead: (status, headers) => response.writeHead(status, {
          ...headers, ...(redirect === undefined ? {} : { location: redirect }),
        }),
        end: (body) => { response.end(body) },
      })
      return
    }
    response.writeHead(ctx.connection.requestRejection(request) ?? 200)
    response.end()
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  // The real HTTP server above owns routing; descriptor publication uses only this port.
  ctx.provide('webServer', {
    port, register: () => () => {}, registerUpgrade: () => () => {}, tapIndex: () => () => {},
  } as unknown as WebServer)
  const origin = `http://127.0.0.1:${String(port)}`
  const descriptor: LocalConnectionDescriptor = {
    version: 1, generation: 'local-test', launchUrl: ctx.connection.authenticatedUrl(origin),
  }
  const config = { descriptorPath, maxDescriptorBytes: 32768 }
  async function write(value: unknown = descriptor) {
    await writeFile(descriptorPath, JSON.stringify(value), { mode: 0o600 })
  }
  async function publish(path = descriptorPath) {
    let generation = ''
    const fiber = ctx.plugin({
      inject: ['connection', 'webServer'],
      async apply(owner: Context) {
        const descriptor = publishLocalConnectionDescriptor(owner, { descriptorPath: path }, 'local-access-test')
        generation = descriptor.generation
        await descriptor.ready
      },
    })
    await fiber
    return { generation, dispose: () => fiber.dispose() }
  }
  return { directory, config, ctx, descriptor, origin, received, write, publish,
    redirectTo: (target: string) => { redirect = target } }
}

describe.skipIf(process.platform === 'win32')('same-user local Connection capability', () => {
  it('exchanges the real process token and returns a cookie accepted by the same Connection', async () => {
    const f = await fixture()
    await f.write()
    const result = await authenticateLocalConnection(f.config, new AbortController().signal)
    expect(result).toMatchObject({ origin: f.origin, generation: f.descriptor.generation })
    expect(result.cookie).toMatch(/^dsh-auth-/u)
    expect(result.cookie).not.toContain(new URL(f.descriptor.launchUrl).searchParams.get('token'))
    const response = await fetch(`${result.origin}/protected`, { headers: { cookie: result.cookie } })
    expect(response.status).toBe(200)
    await response.body?.cancel()
    expect(f.received).toHaveLength(2)
  })

  it('rejects a wrong launch token through real Connection authorization', async () => {
    const f = await fixture()
    await f.write({ ...f.descriptor, launchUrl: `${f.origin}/?token=wrong` })
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .rejects.toMatchObject({ code: 'authentication-failed' })
    expect(f.received).toEqual(['/?token=wrong'])
  })

  it.each(['/not-root', 'http://localhost/'])('refuses login redirect %s even with a real signed cookie', async (target) => {
    const f = await fixture()
    await f.write()
    f.redirectTo(target)
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .rejects.toMatchObject({ code: 'authentication-failed' })
    expect(f.received).toHaveLength(1)
  })

  it.each(['http://localhost/?token=fixture', 'https://127.0.0.1/?token=fixture', 'http://127.0.0.1/api?token=fixture'])
  ('refuses a descriptor outside the exact loopback root exchange: %s', async (launchUrl) => {
    const f = await fixture()
    await f.write({ ...f.descriptor, launchUrl })
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    expect(f.received).toEqual([])
  })

  it('bounds the complete descriptor in UTF-8 bytes', async () => {
    const f = await fixture()
    const descriptor = { ...f.descriptor, generation: '中文🙂' }
    await f.write(descriptor)
    const bytes = Buffer.byteLength(JSON.stringify(descriptor))
    await expect(authenticateLocalConnection({ ...f.config, maxDescriptorBytes: bytes }, new AbortController().signal))
      .resolves.toMatchObject({ generation: descriptor.generation })
    await expect(authenticateLocalConnection({ ...f.config, maxDescriptorBytes: bytes - 1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-too-large' })
    expect(f.received).toHaveLength(1)
  })

  it.each(['json', 'object', 'version', 'generation', 'launch-type', 'launch-url'] as const)
  ('refuses malformed descriptor %s before contacting the Host', async (changed) => {
    const f = await fixture()
    const value: unknown = changed === 'object' ? [] : {
      ...f.descriptor,
      ...(changed === 'version' ? { version: 2 } : {}),
      ...(changed === 'generation' ? { generation: '' } : {}),
      ...(changed === 'launch-type' ? { launchUrl: 1 } : {}),
      ...(changed === 'launch-url' ? { launchUrl: 'not a URL' } : {}),
    }
    await writeFile(f.config.descriptorPath, changed === 'json' ? '{' : JSON.stringify(value), { mode: 0o600 })
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    expect(f.received).toEqual([])
  })

  it('refuses relative descriptor configuration and reports a missing descriptor without login', async () => {
    const f = await fixture()
    const relative = { ...f.config, descriptorPath: 'connection.json' }
    expect(() => publishLocalConnectionDescriptor(f.ctx, relative, 'fixture')).toThrow('descriptorPath must be absolute')
    await expect(authenticateLocalConnection(relative, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-unavailable' })
    expect(f.received).toEqual([])
  })

  it.each(['mode', 'symlink'] as const)('rejects a descriptor parent with unsafe %s for publication and authentication', async (changed) => {
    const f = await fixture()
    await f.write()
    let descriptorPath = f.config.descriptorPath
    if (changed === 'mode') await chmod(f.directory, 0o755)
    else {
      const alias = join(f.directory, 'alias')
      await symlink(f.directory, alias, 'dir')
      descriptorPath = join(alias, 'connection.json')
    }
    await expect(f.publish(descriptorPath)).rejects.toThrow('descriptor-invalid')
    await expect(authenticateLocalConnection({ ...f.config, descriptorPath }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    expect(f.received).toEqual([])
  })

  it('refuses a file replaced between metadata inspection and opening', async () => {
    const f = await fixture()
    await f.write()
    const replacement = join(f.directory, 'replacement.json')
    await writeFile(replacement, JSON.stringify(f.descriptor), { mode: 0o600 })
    boundary.afterLstat = async (path) => {
      if (path !== f.config.descriptorPath) return
      boundary.afterLstat = undefined
      await rename(replacement, path)
    }
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    expect(f.received).toEqual([])
  })

  it('preserves cancellation during descriptor inspection before authentication', async () => {
    const f = await fixture()
    await f.write()
    const controller = new AbortController()
    const reason = new Error('cancelled descriptor read')
    boundary.afterLstat = async (path) => {
      if (path === f.config.descriptorPath) controller.abort(reason)
    }
    await expect(authenticateLocalConnection(f.config, controller.signal)).rejects.toBe(reason)
    expect(f.received).toEqual([])
  })

  it.each(['directory', 'file', 'symlink'])('rejects unsafe capability %s before login', async (kind) => {
    const f = await fixture()
    await f.write()
    let descriptorPath = f.config.descriptorPath
    if (kind === 'directory') await chmod(f.directory, 0o755)
    else if (kind === 'file') await chmod(descriptorPath, 0o644)
    else {
      descriptorPath = join(f.directory, 'alias.json')
      await symlink(f.config.descriptorPath, descriptorPath)
    }
    await expect(authenticateLocalConnection({ ...f.config, descriptorPath }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'descriptor-invalid' })
    expect(f.received).toEqual([])
  })

  it('preserves caller cancellation before reading or sending', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const reason = new Error('fixture cancellation')
    controller.abort(reason)
    await expect(authenticateLocalConnection(f.config, controller.signal)).rejects.toBe(reason)
    expect(f.received).toEqual([])
  })

  it('preserves cancellation during the token exchange and settles its request', async () => {
    const f = await fixture()
    await f.write()
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const reason = new Error('cancelled exchange')
    const fetcher: typeof fetch = () => new Promise<Response>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => { reject(reason) }, { once: true })
      entered.resolve(undefined)
    })
    const result = authenticateLocalConnection(f.config, controller.signal, fetcher)
    const settled = expect(result).rejects.toBe(reason)
    await entered.promise
    controller.abort(reason)
    await settled
    expect(f.received).toEqual([])
  })

  it('redacts a Fetch failure that contains a capability URL', async () => {
    const f = await fixture()
    await f.write()
    const fetcher: typeof fetch = () => Promise.reject(new Error(`Request failed at ${f.descriptor.launchUrl}`))
    const failure = await authenticateLocalConnection(f.config, new AbortController().signal, fetcher).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LocalConnectionAccessError)
    expect(failure).toMatchObject({ code: 'transport-failed', message: 'transport-failed' })
    expect(String(failure)).not.toContain('token=')
    expect(f.received).toEqual([])
  })

  it('publishes before activation completes and deletes its owned generation on dispose', async () => {
    const f = await fixture()
    const owner = await f.publish()
    const value: unknown = JSON.parse(await readFile(f.config.descriptorPath, 'utf8'))
    expect(value).toMatchObject({ version: 1, generation: owner.generation })
    expect((await lstat(f.config.descriptorPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(`${f.config.descriptorPath}.lock`)).mode & 0o777).toBe(0o600)
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .resolves.toMatchObject({ generation: owner.generation })
    await owner.dispose()
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(`${f.config.descriptorPath}.lock`)).isFile()).toBe(true)
  })

  it('leaves a replacement generation intact on disposal', async () => {
    const f = await fixture()
    const owner = await f.publish()
    await f.write({ ...f.descriptor, generation: 'replacement' })
    await owner.dispose()
    expect(JSON.parse(await readFile(f.config.descriptorPath, 'utf8'))).toMatchObject({ generation: 'replacement' })
  })

  it('settles cancellation during publication before disposal returns', async () => {
    const f = await fixture()
    const descriptor = publishLocalConnectionDescriptor(f.ctx, f.config, 'cancelled-local-access')
    const publication = expect(descriptor.ready).rejects.toThrow('publication-failed')
    const disposal = f.ctx.fiber.dispose()
    await Promise.all([publication, disposal])
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a concurrent publisher and releases the lease for a successor after disposal', async () => {
    const f = await fixture()
    const owner = await f.publish()
    const original = await readFile(f.config.descriptorPath, 'utf8')
    await expect(f.publish()).rejects.toThrow('publication-failed')
    expect(await readFile(f.config.descriptorPath, 'utf8')).toBe(original)
    await owner.dispose()
    const successor = await f.publish()
    expect(successor.generation).not.toBe(owner.generation)
    expect(JSON.parse(await readFile(f.config.descriptorPath, 'utf8'))).toMatchObject({ generation: successor.generation })
    await successor.dispose()
  })

  it.each(['missing', 'corrupt'] as const)('releases its lease when its descriptor is %s at disposal', async (changed) => {
    const f = await fixture()
    const owner = await f.publish()
    const errors = vi.spyOn(f.ctx.logger, 'error')
    if (changed === 'missing') await unlink(f.config.descriptorPath)
    else await writeFile(f.config.descriptorPath, '{')
    await owner.dispose()
    if (changed === 'corrupt') {
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'descriptor-invalid' }))
      expect(await readFile(f.config.descriptorPath, 'utf8')).toBe('{')
    } else expect(errors).not.toHaveBeenCalled()
    const successor = await f.publish()
    await successor.dispose()
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a replaced lease inode and closes the displaced locked descriptor', async () => {
    const f = await fixture()
    const lock = `${f.config.descriptorPath}.lock`
    const displaced = join(f.directory, 'displaced.lock')
    boundary.beforeLstat = async (path) => {
      if (path !== lock) return
      boundary.beforeLstat = undefined
      await rename(lock, displaced)
      await writeFile(lock, '', { mode: 0o600 })
    }
    await expect(f.publish()).rejects.toThrow('publication-failed')
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const file = await open(displaced, 'r+')
    try { await tryLockExclusive(file.fd) } finally { await file.close() }
    const successor = await f.publish()
    await successor.dispose()
  })

  it('rejects a temporary-file cleanup failure and rolls back its committed descriptor', async () => {
    const f = await fixture()
    let replacedTemporary: string | undefined
    boundary.afterRename = async (temporary, destination) => {
      if (destination !== f.config.descriptorPath) return
      boundary.afterRename = undefined
      replacedTemporary = temporary
      await mkdir(temporary, { mode: 0o700 })
    }
    await expect(f.publish()).rejects.toThrow('publication-failed')
    expect(replacedTemporary).toBeDefined()
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const successor = await f.publish()
    await successor.dispose()
  })

  it('rejects a symlink lock without changing its target', async () => {
    const f = await fixture()
    const target = join(f.directory, 'unrelated')
    await writeFile(target, 'preserve', { mode: 0o600 })
    await symlink(target, `${f.config.descriptorPath}.lock`)
    await expect(f.publish()).rejects.toThrow('local-access-test could not publish its private connection descriptor: publication-failed')
    expect(await readFile(target, 'utf8')).toBe('preserve')
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('refuses Windows capability access before reading files or sending requests', async () => {
  const platform = process.platform
  const fetcher = vi.fn<typeof fetch>()
  const ctx = new Context()
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const config = { descriptorPath: 'C:\\private\\connection.json', maxDescriptorBytes: 32768 }
    await expect(authenticateLocalConnection(config, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: 'platform-unsupported', message: 'platform-unsupported' })
    expect(() => publishLocalConnectionDescriptor(ctx, config, 'fixture')).toThrow('platform-unsupported')
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
    await ctx.fiber.dispose()
  }
})
