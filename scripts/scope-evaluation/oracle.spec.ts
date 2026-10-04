/** Real controlled child execution and negative controls for the offline artifact oracle. */
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, test } from 'vitest'
import { createFixtures } from './fixtures.ts'
import { grade, type GradeRequest } from './oracle.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scope-oracle-spec-'))
  roots.push(root)
  return root
}
function fixtureAt(index: number) {
  const fixture = createFixtures(20261003)[index]
  if (!fixture) throw new Error('missing controlled fixture')
  return fixture
}

describe('controlled artifact oracle', () => {
  test.each([0, 1, 2, 3, 4])('executes correct client and QA plus required mutants for case %i', async (index) => {
    const workRoot = await workspace()
    const fixture = fixtureAt(index)
    {
      const result = await grade({ fixture, clientSource: fixture.correctClientSource, testSource: fixture.correctTestSource, workRoot })
      expect(result, JSON.stringify(result, null, 2)).toMatchObject({
        controlledPairPass: true, client: { executionValid: true, pass: true }, tests: { pass: true },
      })
      expect(result.cleanup.childrenClosed).toBe(result.cleanup.childrenStarted)
      for (const mutant of fixture.mutants) {
        const result = await grade({ fixture, clientSource: mutant.clientSource, testSource: fixture.correctTestSource, workRoot })
        expect(result.client).toMatchObject({ executionValid: true, pass: false })
        expect(result.tests.pass).toBe(true)
        expect(result.controlledPairPass).toBe(false)
        expect(result.cleanup.childrenClosed).toBe(result.cleanup.childrenStarted)
      }
    }
    expect(await readdir(workRoot)).toEqual([])
  })

  test.each(['always-pass', 'always-fail', 'string-only', 'empty', 'syntax-error', 'oracle-read', 'path-fingerprint'] as const)('rejects %s QA without counting execution failures as kills', async (control) => {
    const fixture = fixtureAt(0)
    const result = await grade({ fixture, clientSource: fixture.correctClientSource, testSource: fixture.testControls[control] })
    expect(result.client.pass).toBe(true)
    expect(result.tests.pass).toBe(false)
    if (control === 'oracle-read') expect(result.tests.correct.errors.some(error => error.code === 'ERR_ACCESS_DENIED')).toBe(true)
    expect(result.tests.mutants.every(mutant => !mutant.killed)).toBe(true)
    expect(result.controlledPairPass).toBe(false)
    expect(result.cleanup.childrenClosed).toBe(result.cleanup.childrenStarted)
  })

  test.each(['constant-success', 'literal-sku', 'syntax-error', 'early-disconnect'] as const)('rejects %s client without relying on its QA counterpart', async (control) => {
    const fixture = fixtureAt(0)
    const result = await grade({ fixture, clientSource: fixture.clientControls[control], testSource: fixture.correctTestSource })
    expect(result.client.pass).toBe(false)
    expect(result.client.executionValid).toBe(control !== 'syntax-error' && control !== 'early-disconnect')
    expect(result.tests.pass).toBe(true)
    expect(result.controlledPairPass).toBe(false)
  })

  test('bounds hanging controlled tests and awaits child exit before deleting files', async () => {
    const fixture = fixtureAt(0)
    const workRoot = await workspace()
    const result = await grade({ fixture, clientSource: fixture.correctClientSource,
      testSource: fixture.testControls.hang, workRoot, timeoutMs: 500 })
    expect(result.tests.correct.outcome).toBe('timeout')
    expect(result.tests.mutants.every(mutant => !mutant.killed)).toBe(true)
    expect(result.cleanup.childrenClosed).toBe(result.cleanup.childrenStarted)
    expect(await readdir(workRoot)).toEqual([])
  })

  test('uses deterministic field mappings and held-out values, with isolated concurrent runs', async () => {
    const first = fixtureAt(0)
    const same = fixtureAt(0)
    const changed = createFixtures(7)[0]
    if (!changed) throw new Error('missing changed seed')
    expect(first).toEqual(same)
    expect(first.mappedFields).not.toEqual(changed.mappedFields)
    expect(first.correctTestSource).not.toContain('held-out-')
    const workRoot = await workspace()
    const results = await Promise.all([first, changed].map(fixture => grade({
      fixture, clientSource: fixture.correctClientSource, testSource: fixture.correctTestSource, workRoot,
    })))
    expect(results.every(result => result.controlledPairPass)).toBe(true)
    expect(await readdir(workRoot)).toEqual([])
  })

  test('exits a hanging controlled runner when its owning IPC connection is lost', async () => {
    const root = await realpath(await workspace())
    const fixture = fixtureAt(0)
    const runner = join(root, 'runner.mjs')
    await copyFile(fileURLToPath(new URL('./runner.mjs', import.meta.url)), runner)
    const target = join(root, 'client.mjs')
    await writeFile(target, fixture.clientControls.hang)
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${root}`, runner, 'client', target], {
      cwd: root, env: { LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const ready = Promise.withResolvers<undefined>()
    const hanging = Promise.withResolvers<undefined>()
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) =>{  resolveClose({ code, signal }) })
    })
    child.on('message', (message) => { if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'ready') ready.resolve(undefined) })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.includes('controlled-hang')) hanging.resolve(undefined) })
    child.stderr?.resume()
    const drained = Promise.all([child.stdout, child.stderr].map(stream => stream === null ? Promise.resolve() : finished(stream)))
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    try {
      await Promise.race([ready.promise, closed.then(() => { throw new Error('runner closed before ready') })])
      child.send({ kind: 'call', id: 1 })
      await Promise.race([hanging.promise, closed.then(() => { throw new Error('runner closed before hanging') })])
      child.disconnect()
      expect(await closed).toEqual({ code: 1, signal: null })
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      await drained
    }
  })

  test.each(['node', 'docker'] as const)('rejects arbitrary source and copied fixtures before %s execution is allocated', async (execution) => {
    const fixture = fixtureAt(0)
    const workRoot = await workspace()
    const docker: GradeRequest['docker'] = execution === 'node' ? undefined : {
      dockerPath: '/unavailable-docker-must-not-run', dockerHost: 'unix:///unavailable-docker-must-not-open',
      imageDigest: `node@sha256:${'0'.repeat(64)}`, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 32,
      tmpBytes: 8 * 1024 * 1024, maxWireBytes: 262144, maxDiagnosticBytes: 16384, cleanupTimeoutMs: 5000,
    }
    await expect(grade({ fixture, clientSource: 'process.exit(0)', testSource: fixture.correctTestSource, workRoot, ...(docker === undefined ? {} : { docker }) })).rejects.toThrow('Only registered controlled')
    await expect(grade({ fixture: { ...fixture }, clientSource: fixture.correctClientSource, testSource: fixture.correctTestSource, workRoot, ...(docker === undefined ? {} : { docker }) })).rejects.toThrow('Only registered controlled')
    expect(await readdir(workRoot)).toEqual([])
  })
})
