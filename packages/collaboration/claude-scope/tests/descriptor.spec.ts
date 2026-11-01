import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { ClaudeScopeDescriptor } from '../src/types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'descriptor fixture cleanup failed')
})

async function leaseProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'claude-scope-lease-'))
  await chmod(directory, 0o700)
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const profile = join(home, 'profiles', 'lease-owner')
  const descriptorPath = join(directory, 'connection.json')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'lease-owner', private: true, dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: 'lease-owner', name: new URL('./fixtures/descriptor-owner.mjs', import.meta.url).href, config: { descriptorPath },
  }] }]))
  const invocation = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    mode: 'lib', configArgs: ['--profile', 'lease-owner'],
    env: { DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' },
  })
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name) && !/^(?:DSH_|CLAUDE|NODE_OPTIONS$)/u.test(name)))
  const launch = () => {
    const child = execa(invocation.command, invocation.args, {
      cwd: directory, env: { ...environment, ...invocation.env }, extendEnv: false,
      stdin: 'pipe', reject: false, stripFinalNewline: false, timeout: 20000, killSignal: 'SIGKILL',
    })
    const announced = Promise.withResolvers<string>()
    let stdout = ''
    const observeReady = (chunk: Buffer | string): void => {
      stdout += chunk.toString()
      const generation = /^descriptor-ready: ([^\r\n]+)\r?$/mu.exec(stdout)?.[1]
      if (generation !== undefined) announced.resolve(generation)
    }
    child.stdout?.on('data', observeReady)
    cleanup.push(async () => {
      child.stdout?.off('data', observeReady)
      child.kill('SIGTERM')
      await child
    })
    const whenReady = async (): Promise<string> => {
      try {
        return await Promise.race([
          announced.promise,
          child.then((result) => {
            throw new Error(`descriptor Host exited before publication readiness: exitCode=${String(result.exitCode)}, signal=${String(result.signal)}, timedOut=${String(result.timedOut)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
          }),
        ])
      } finally {
        child.stdout?.off('data', observeReady)
      }
    }
    return { child, whenReady }
  }
  const descriptor = async (): Promise<ClaudeScopeDescriptor> => JSON.parse(await readFile(descriptorPath, 'utf8')) as ClaudeScopeDescriptor
  return { directory, launch, descriptor }
}

describe.skipIf(process.platform === 'win32')('descriptor kernel ownership through dsh profiles', () => {
  it('refuses a live competing Host and recovers a descriptor left by process death', async () => {
    const fixture = await leaseProfile()
    const first = fixture.launch()
    const originalGeneration = await first.whenReady()
    const original = await fixture.descriptor()
    expect(original.generation).toBe(originalGeneration)
    const rejected = await fixture.launch().child
    expect(rejected.timedOut).toBe(false)
    expect(rejected.signal).toBeUndefined()
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stdout).toBe('')
    expect(await fixture.descriptor()).toEqual(original)
    first.child.kill('SIGKILL')
    const killed = await first.child
    expect(killed.timedOut).toBe(false)
    expect(killed.signal).toBe('SIGKILL')
    expect(await fixture.descriptor()).toEqual(original)
    const successor = fixture.launch()
    const successorGeneration = await successor.whenReady()
    expect(successorGeneration).not.toBe(original.generation)
    expect((await fixture.descriptor()).generation).toBe(successorGeneration)
    successor.child.kill('SIGTERM')
    const stopped = await successor.child
    expect(stopped.timedOut).toBe(false)
    expect(stopped.signal).toBeUndefined()
    expect(stopped.exitCode).toBe(0)
    await expect(fixture.descriptor()).rejects.toMatchObject({ code: 'ENOENT' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('reports an early publication failure with the Host exit and stderr', async () => {
    const fixture = await leaseProfile()
    await chmod(fixture.directory, 0o755)
    const failed = fixture.launch()
    await expect(failed.whenReady()).rejects.toThrow('claude-scope could not publish its private connection descriptor: descriptor-invalid')
    const result = await failed.child
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    await expect(fixture.descriptor()).rejects.toMatchObject({ code: 'ENOENT' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
