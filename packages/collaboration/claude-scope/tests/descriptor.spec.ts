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
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
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
    cleanup.push(async () => { child.kill('SIGTERM'); await child })
    return child
  }
  const descriptor = async (): Promise<ClaudeScopeDescriptor | undefined> => {
    try { return JSON.parse(await readFile(descriptorPath, 'utf8')) as ClaudeScopeDescriptor } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }
  return { launch, descriptor }
}

describe.skipIf(process.platform === 'win32')('descriptor kernel ownership through dsh profiles', () => {
  it('refuses a live competing Host and recovers a descriptor left by process death', async () => {
    const fixture = await leaseProfile()
    const first = fixture.launch()
    await expect.poll(fixture.descriptor).toBeDefined()
    const original = (await fixture.descriptor())!
    const rejected = await fixture.launch()
    expect(rejected.timedOut).toBe(false)
    expect(rejected.signal).toBeUndefined()
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stdout).toBe('')
    expect(await fixture.descriptor()).toEqual(original)
    first.kill('SIGKILL')
    const killed = await first
    expect(killed.timedOut).toBe(false)
    expect(killed.signal).toBe('SIGKILL')
    expect(await fixture.descriptor()).toEqual(original)
    const successor = fixture.launch()
    await expect.poll(async () => (await fixture.descriptor())?.generation).not.toBe(original.generation)
    expect((await fixture.descriptor())?.generation).toBeTypeOf('string')
    successor.kill('SIGTERM')
    const stopped = await successor
    expect(stopped.timedOut).toBe(false)
    await expect.poll(fixture.descriptor).toBeUndefined()
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
