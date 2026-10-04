/** Private local capabilities use the real Connection token and cookie verifier. */
import { Context } from '@deepseek-ai/cordis'
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
  const ready = new Set<() => void>()
  const exit = vi.fn<(code: number) => void>()
  ctx.provide('appReady', { onReady: (listener) => { ready.add(listener); return () => { ready.delete(listener) } } })
  ctx.provide('appExit', exit)
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
      apply(owner: Context) { generation = publishLocalConnectionDescriptor(owner, { descriptorPath: path }, 'local-access-test').generation },
    })
    await fiber.await()
    return { generation, dispose: () => fiber.dispose() }
  }
  function fireReady() {
    const callbacks = [...ready]
    ready.clear()
    for (const callback of callbacks) callback()
  }
  return { directory, config, ctx, descriptor, origin, received, exit, write, publish, fireReady,
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

  it('publishes only after readiness and deletes its owned generation on dispose', async () => {
    const f = await fixture()
    const owner = await f.publish()
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    f.fireReady()
    await vi.waitFor(async () => {
      const value: unknown = JSON.parse(await readFile(f.config.descriptorPath, 'utf8'))
      expect(value).toMatchObject({ version: 1, generation: owner.generation })
    })
    expect((await lstat(f.config.descriptorPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(`${f.config.descriptorPath}.lock`)).mode & 0o777).toBe(0o600)
    await expect(authenticateLocalConnection(f.config, new AbortController().signal))
      .resolves.toMatchObject({ generation: owner.generation })
    await owner.dispose()
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(`${f.config.descriptorPath}.lock`)).isFile()).toBe(true)
    expect(f.exit).not.toHaveBeenCalled()
  })

  it('cancels pending readiness and leaves a replacement generation intact', async () => {
    const f = await fixture()
    const cancelled = await f.publish()
    await cancelled.dispose()
    f.fireReady()
    await expect(lstat(f.config.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const owner = await f.publish()
    f.fireReady()
    await vi.waitFor(async () => { expect((await lstat(f.config.descriptorPath)).isFile()).toBe(true) })
    await f.write({ ...f.descriptor, generation: 'replacement' })
    await owner.dispose()
    expect(JSON.parse(await readFile(f.config.descriptorPath, 'utf8'))).toMatchObject({ generation: 'replacement' })
  })

  it('rejects a symlink lock without changing its target', async () => {
    const f = await fixture()
    const target = join(f.directory, 'unrelated')
    await writeFile(target, 'preserve', { mode: 0o600 })
    await symlink(target, `${f.config.descriptorPath}.lock`)
    const owner = await f.publish()
    f.fireReady()
    await vi.waitFor(() => { expect(f.exit).toHaveBeenCalledWith(1) })
    await owner.dispose()
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
