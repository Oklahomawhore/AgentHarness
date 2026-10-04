import { once } from 'node:events'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { startDockerProgram, type DockerProgramHandle, type DockerProgramRequest } from './docker-execution.ts'

const dockerConfigSchema = z.object({
  imageDigest: z.string(), dockerPath: z.string(), dockerHost: z.string(),
  memoryBytes: z.number(), cpus: z.number(), pidsLimit: z.number(), tmpBytes: z.number(),
  maxWireBytes: z.number(), maxDiagnosticBytes: z.number(), cleanupTimeoutMs: z.number(),
}).strict()

const roots: string[] = []
const handles: DockerProgramHandle[] = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: 'client' | 'tests', source: string, configuration: Partial<DockerProgramRequest> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scope-docker-spec-'))
  roots.push(root)
  await mkdir(join(root, 'qa'))
  const target = join(root, mode === 'tests' ? 'qa/contract.test.mjs' : 'client.mjs')
  await writeFile(target, source, { mode: 0o600 })
  return { root, target, mode, imageDigest: `node@sha256:${'a'.repeat(64)}`, dockerPath: '/missing/docker',
    dockerHost: 'unix:///missing/docker.sock', nodePath: process.execPath,
    runner: fileURLToPath(new URL('./runner.mjs', import.meta.url)), timeoutMs: 10000,
    memoryBytes: 268435456, cpus: 0.5, pidsLimit: 32, tmpBytes: 16777216,
    maxWireBytes: 262144, maxDiagnosticBytes: 16384, cleanupTimeoutMs: 10000, ...configuration }
}

it('rejects a floating image before contacting a daemon', async () => {
  const request = await fixture('client', 'export function submit(){}', { imageDigest: 'node:24-slim' })
  await expect(startDockerProgram(request)).rejects.toThrow('pinned official Node digest')
})

it('rejects a role target outside its sole mounted directory', async () => {
  const request = await fixture('client', 'export function submit(){}')
  const sibling = await fixture('client', 'export function submit(){}')
  await expect(startDockerProgram({ ...request, target: sibling.target })).rejects.toThrow('inside its role directory')
})

it.each([0, -1, Number.POSITIVE_INFINITY, 1.5])('rejects invalid resource limit %s before contacting a daemon', async (memoryBytes) => {
  const request = await fixture('client', 'export function submit(){}', { memoryBytes })
  await expect(startDockerProgram(request)).rejects.toThrow('positive safe integers')
})

it.each(['timeoutMs', 'cleanupTimeoutMs'] as const)('rejects overflowing %s instead of scheduling a one-millisecond deadline', async (field) => {
  const request = await fixture('client', 'export function submit(){}', { [field]: 2 ** 31 })
  await expect(startDockerProgram(request)).rejects.toThrow('Node timer range')
})

// This opt-in suite uses an already running local daemon and an already pulled immutable image; it never pulls or starts services.
const configPath = process.env.DSH_SCOPE_DOCKER_TEST_CONFIG
const realDocker = describe.skipIf(configPath === undefined || process.platform === 'win32')
realDocker('existing Docker isolation', () => {
  async function launch(mode: 'client' | 'tests', source: string, extra: Partial<DockerProgramRequest> = {}) {
    if (configPath === undefined) throw new Error('Explicit Docker test configuration is required')
    const config = dockerConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
    const request = await fixture(mode, source, { ...config, ...extra })
    const handle = await startDockerProgram(request)
    handles.push(handle)
    const errors: Buffer[] = []
    handle.child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
    return { request, handle, errors, closed: once(handle.child, 'close') }
  }

  it('preserves IPC and exit zero, then proves exact image, mount restrictions and removal', async () => {
    const { request, handle, closed, errors } = await launch('client', 'export async function submit(value){return {echo:value}}')
    const ready = once(handle.child, 'message')
    handle.start()
    handle.start()
    expect((await ready)[0]).toEqual({ kind: 'ready' })
    const answer = once(handle.child, 'message')
    handle.child.send({ kind: 'call', id: 1, payload: 'value' })
    expect((await answer)[0]).toEqual({ kind: 'result', id: 1, ok: true, value: { echo: 'value' } })
    handle.child.send({ kind: 'stop' })
    expect(await closed, Buffer.concat(errors).toString()).toEqual([0, null])
    const receipt = await handle.dispose()
    expect(receipt).toMatchObject({ imageDigest: request.imageDigest, removed: true, exitCode: 0, oomKilled: false,
      limits: { network: 'none', readOnlyRoot: true, memoryBytes: request.memoryBytes, pidsLimit: request.pidsLimit } })
    expect(receipt.limits.mounts).toHaveLength(3)
    expect(receipt.limits.mounts.every(mount => !mount.writable)).toBe(true)
    expect(await handle.dispose()).toEqual(receipt)
    const remaining = await execa(request.dockerPath, ['--config', request.root, '--host', request.dockerHost, 'ps', '-a', '--no-trunc',
      '--filter', `id=${receipt.containerId}`, '--format', '{{.ID}}'], { extendEnv: false, env: { PATH: '/usr/bin:/bin' } })
    expect(remaining.stdout).toBe('')
  })

  it.each([false, true])('preserves test assertion exit status (failure=%s) and writes only the verdict file', async (failure) => {
    const { handle, request, closed, errors } = await launch('tests', `
import {test} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
test('bounded role writes',async()=>{
  await fs.writeFile('/work/qa/verdict.json','{"reviewed":true}');
  await assert.rejects(fs.writeFile('/work/qa/other.json','forbidden'));
  await assert.rejects(fs.writeFile('/outside-output','forbidden'));
  assert.equal(${failure},false);
});`)
    const report = once(handle.child, 'message')
    handle.start()
    expect((await report)[0]).toMatchObject({ kind: 'report', value: { testCount: 1, assertionFailures: failure ? 1 : 0 } })
    expect(await closed, Buffer.concat(errors).toString()).toEqual([failure ? 1 : 0, null])
    expect(await readFile(join(request.root, 'qa/verdict.json'), 'utf8')).toBe('{"reviewed":true}')
    const receipt = await handle.dispose()
    expect(receipt.exitCode).toBe(failure ? 1 : 0)
    expect(receipt.limits.mounts.filter(mount => mount.writable).map(mount => mount.destination)).toEqual(['/work/qa/verdict.json'])
  })

  it('removes the container after its host proxy is unexpectedly killed', async () => {
    const { handle, closed } = await launch('client', 'export function submit(){return new Promise(()=>{})}')
    const ready = once(handle.child, 'message')
    handle.start()
    await ready
    handle.child.kill('SIGKILL')
    expect(await closed).toEqual([null, 'SIGKILL'])
    const receipt = await handle.dispose()
    expect(receipt.removed).toBe(true)
    expect(receipt.exitCode).not.toBe(0)
    await handle.terminate()
  })

  it('can terminate a created program before start without admitting any code', async () => {
    const { handle, closed } = await launch('client', 'throw new Error("must not execute")')
    await Promise.all([handle.terminate(), handle.terminate()])
    handle.start()
    await closed
    expect(await handle.dispose()).toMatchObject({ removed: true, exitCode: null })
  })

  it('kills a stalled program at its explicit container deadline and retains the nonzero exit', async () => {
    const { handle, closed } = await launch('client', 'export function submit(){return new Promise(()=>{})}', { timeoutMs: 1000 })
    const ready = once(handle.child, 'message')
    handle.start()
    await ready
    handle.child.send({ kind: 'call', id: 1, payload: null })
    expect(await closed).toEqual([1, null])
    expect(await handle.dispose()).toMatchObject({ removed: true, exitCode: 1 })
  })

  it('rejects failed daemon cleanup while still settling its local proxy', async () => {
    if (configPath === undefined) throw new Error('Explicit Docker test configuration is required')
    const config = dockerConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
    const directory = await mkdtemp(join(tmpdir(), 'scope-docker-failing-cli-'))
    roots.push(directory)
    const marker = join(directory, 'fail')
    const wrapper = join(directory, 'docker.mjs')
    const createdId = join(directory, 'created-id')
    await writeFile(wrapper, `#!${process.execPath}
import {existsSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
if(existsSync(${JSON.stringify(marker)})){process.stderr.write('controlled daemon unavailable');process.exit(42)}
const args=process.argv.slice(2);const result=spawnSync(${JSON.stringify(config.dockerPath)},args,{encoding:'utf8',stdio:args.includes('create')?'pipe':'inherit',env:process.env});
if(args.includes('create')&&result.status===0)writeFileSync(${JSON.stringify(createdId)},result.stdout.trim());
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);
`)
    await chmod(wrapper, 0o700)
    const { handle, closed } = await launch('client', 'export function submit(){return null}', { dockerPath: wrapper })
    const ready = once(handle.child, 'message')
    handle.start()
    await ready
    await writeFile(marker, 'fail')
    try {
      await expect(handle.terminate()).rejects.toThrow('controlled daemon unavailable')
      expect(await closed).toEqual([null, 'SIGKILL'])
      await expect(handle.dispose()).rejects.toThrow('controlled daemon unavailable')
    } finally {
      // The wrapper simulates an unavailable daemon only for this handle; release its exact owned container through the real CLI.
      handles.splice(handles.indexOf(handle), 1)
      await rm(marker)
      const id = await readFile(createdId, 'utf8')
      expect(id).toMatch(/^[a-f0-9]{64}$/)
      await execa(config.dockerPath, ['--config', directory, '--host', config.dockerHost, 'rm', '--force', id],
        { extendEnv: false, env: { PATH: '/usr/bin:/bin' } })
    }
  })
})
