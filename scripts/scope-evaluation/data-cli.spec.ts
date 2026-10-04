/** Frozen registration checks do not open credentials, allocate Hosts, or dispatch model calls. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectDataStudy, prepareDataStudy, runDataPhase } from './data-cli.ts'

const owned: string[] = []
afterEach(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }) })
const route = { provider: 'deepseek-official', model: 'explicitly-selected-model', endpoint: 'https://api.deepseek.com/',
  apiKeyEnv: 'UNUSED_DATA_STUDY_KEY', credentialsPath: '/missing/data-study-credentials.yaml',
  maxCalls: 4, maxInputBytes: 32768, maxOutputTokens: 2048, maxOutputBytes: 16384, timeoutMs: 30000 }
const config = { ordinary: route, semantic: { ...route, maxCalls: 2 }, limits: { contextBytes: 8192,
  maxArtifactBytes: 32768, wallTimeoutMs: 300000, cleanupTimeoutMs: 10000, operationTimeoutMs: 30000 } }
async function fresh(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scope-data-registration-')); owned.push(root)
  return join(root, 'study')
}

// Public built entries are an explicit prerequisite, never silently replaced with source imports.
describe.skipIf(process.env['DSH_NATIVE_EVALUATION'] !== '1')('ordinary data registration with built public dependencies', () => {
  it('preflights a frozen live registration with unavailable credentials without launching or calling anything', async () => {
    const root = await fresh()
    const manifest = await prepareDataStudy({ root, seed: 31, execution: 'live', config })
    expect(manifest.maximumDispatches).toBe(26)
    expect(manifest.conditions).toEqual(['N', 'E', 'R'])
    expect((await inspectDataStudy(root)).study.runtime.roles.B.writableFiles).toEqual(['client/payment-policy.json'])
    const result = await runDataPhase('preflight', root)
    expect(result).toMatchObject({ failed: false, credentialRead: false, hostsStarted: 0, modelDispatches: 0, liveModelDispatches: 0 })
    expect((await readdir(root)).sort()).toEqual(['manifest.json', 'preflight', 'registration.json'])
    expect((await readdir(join(root, 'preflight')))).toEqual(['result.json'])
    await expect(runDataPhase('preflight', root)).rejects.toThrow()
    await expect(prepareDataStudy({ root, seed: 31, execution: 'live', config })).rejects.toThrow()
  })

  it('refuses changed fixture registration, node identity, and source fingerprints before creating an execute directory', async () => {
    const root = await fresh()
    const manifest = await prepareDataStudy({ root, seed: 32, execution: 'live', config })
    const manifestPath = join(root, 'manifest.json')
    for (const changed of [{ ...manifest, seed: 33 }, { ...manifest, nodeVersion: 'changed' },
      { ...manifest, maximumDispatches: 99 }, { ...manifest, sourceHashes: {} }, { ...manifest, artifactHashes: {} },
      { ...manifest, sourceHashes: { [manifestPath]: '0'.repeat(64) } }]) {
      await writeFile(manifestPath, JSON.stringify(changed) + '\n')
      await expect(runDataPhase('execute', root)).rejects.toThrow()
      expect(await readdir(root)).not.toContain('execute')
    }
    await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
    expect((await inspectDataStudy(root)).manifest.seed).toBe(32)
    const registration = JSON.parse(await readFile(join(root, 'registration.json'), 'utf8')) as unknown
    expect(registration).toMatchObject({ modelDispatches: 0, credentialRead: false })
  })

  it('refuses live/calibration provenance changes without accessing a provider', async () => {
    const root = await fresh()
    const manifest = await prepareDataStudy({ root, seed: 33, execution: 'live', config })
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, execution: 'transport-calibration' }) + '\n')
    await expect(inspectDataStudy(root)).rejects.toThrow('must not load credential files')
    expect(await readdir(root)).not.toContain('execute')
  })
})
