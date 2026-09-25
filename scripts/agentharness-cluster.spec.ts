import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { copyClusterRuntime } from './agentharness-portable-fixture.ts'
import { ensureClusterCredential, joinCluster, readClusterCredential } from './agentharness-cluster.mjs'

const secret = 'test-cluster-secret-material-that-is-long-enough'
const replacement = 'another-test-cluster-secret-material-that-is-long-enough'
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(text?: string): Promise<{ environment: NodeJS.ProcessEnv; filename: string }> {
  const home = await mkdtemp(join(tmpdir(), 'agentharness-credentials-'))
  directories.push(home)
  const filename = join(home, '.credentials.yaml')
  if (text !== undefined) await writeFile(filename, text, { mode: 0o600 })
  return { environment: { DSH_HOME: home }, filename }
}

async function bootProvider(filename: string): Promise<void> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path: filename, watch: false })
  try { await fiber } finally { await fiber.dispose() }
}

it('retains one cluster across provider boot, restart, and repeated installation', async () => {
  const { environment, filename } = await fixture()
  const first = await ensureClusterCredential(environment)
  await bootProvider(filename)
  const before = await readFile(filename, 'utf8')
  expect(parseCredentialsDocument(before, filename).refs.get('AGENTHARNESS_MESH_SECRET')).toBe(first.secret)
  expect(await ensureClusterCredential(environment)).toEqual(first)
  expect(await joinCluster(first.secret, { environment })).toMatchObject({ changed: false, clusterId: first.clusterId })
  await bootProvider(filename)
  expect(await readFile(filename, 'utf8')).toBe(before)
})

it('reads an existing flat credential after the provider migrates it', async () => {
  const { environment, filename } = await fixture(`AGENTHARNESS_MESH_SECRET: ${JSON.stringify(secret)}\n`)
  const first = await readClusterCredential(environment)
  await bootProvider(filename)
  expect(await readClusterCredential(environment)).toEqual(first)
  expect(await ensureClusterCredential(environment)).toEqual(first)
  await bootProvider(filename)
})

it.each([
  '# retain comment\n',
  'version: 1\nrefs:\n  OTHER_KEY: "unchanged" # retain comment\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: browser-secret\n',
  JSON.stringify({ version: 1, refs: { OTHER_KEY: 'unchanged' }, records: {} }),
  'OTHER_KEY: "unchanged" # retain comment\n',
  'version: 1\nrefs: null\nrecords: null\n',
])('writes a reference the real provider accepts while preserving other entries: %s', async (text) => {
  const { environment, filename } = await fixture(text)
  await joinCluster(secret, { environment })
  const written = await readFile(filename, 'utf8')
  const parsed = parseCredentialsDocument(written, filename)
  expect(parsed.refs.get('AGENTHARNESS_MESH_SECRET')).toBe(secret)
  if (text.includes('OTHER_KEY')) expect(parsed.refs.get('OTHER_KEY')).toBe('unchanged')
  if (text.includes('retain comment')) expect(written).toContain('# retain comment')
  if (text.includes('browser-session')) expect(parsed.records.get('client-connection/browser-session')).toEqual({ kind: 'grant', payload: { secret: 'browser-secret' } })
  await bootProvider(filename)
})

it('requires explicit replacement of a versioned cluster', async () => {
  const { environment, filename } = await fixture()
  await joinCluster(secret, { environment })
  const before = await readFile(filename, 'utf8')
  await expect(joinCluster(replacement, { environment })).rejects.toThrow('refusing to replace cluster')
  expect(await readFile(filename, 'utf8')).toBe(before)
  await joinCluster(replacement, { environment, replace: true })
  expect((await readClusterCredential(environment))?.secret).toBe(replacement)
  await bootProvider(filename)
})

it.each([
  'refs: { BAD-KEY: private-secret-value }',
  'refs: { OTHER_KEY: 123 }',
  'refs: { OTHER_KEY: "" }',
  'records: { invalid: { kind: grant, payload: null } }',
  'records: { llm/example: { kind: grant, payload: null, unknown: private-secret-value } }',
  'records: { llm/example: { kind: grant } }',
  'records: { llm/example: { kind: grant, payload: .inf } }',
  'records: { llm/example: { kind: private-secret-value } }',
  'records: { llm/example: { kind: api-key, key: "" } }',
  'records: { llm/example: { kind: api-key, env: { BAD-KEY: private-secret-value } } }',
])('rejects provider-invalid unrelated entries before adding or retaining a cluster: %s', async (section) => {
  const text = `version: 1\n${section}\n`
  const { environment, filename } = await fixture(text)
  expect(() => parseCredentialsDocument(text, filename)).toThrow()
  await expect(joinCluster(secret, { environment })).rejects.toMatchObject({
    message: `credentials document at ${filename} contains invalid references or records; repair these entries before changing clusters`,
  })
  expect(await readFile(filename, 'utf8')).toBe(text)
  await expect(ensureClusterCredential(environment)).rejects.toThrow()
  expect(await readFile(filename, 'utf8')).toBe(text)

  const reference = `AGENTHARNESS_MESH_SECRET: ${JSON.stringify(secret)}`
  const withCluster = section.startsWith('refs:')
    ? text.replace('refs: {', `refs: { ${reference},`)
    : `${text}refs: { ${reference} }\n`
  await writeFile(filename, withCluster, { mode: 0o600 })
  await expect(joinCluster(secret, { environment })).rejects.toThrow('contains invalid references or records')
  expect(await readFile(filename, 'utf8')).toBe(withCluster)
})

it.each([
  `version: 1\nrefs:\n  AGENTHARNESS_MESH_SECRET: ${JSON.stringify(secret)}\nAGENTHARNESS_MESH_SECRET: ${JSON.stringify(replacement)}\n`,
  'version: 2\nrefs: {}\n',
  'version: 1\nrefs: []\n',
  'version: 1\nrefs: {}\nrefs: {}\n',
  'version: 1\nrefs: [private-secret-value\n',
])('refuses invalid documents without overwriting them or disclosing values: %s', async (text) => {
  const { environment, filename } = await fixture(text)
  for (const operation of [() => ensureClusterCredential(environment), () => joinCluster(secret, { environment, replace: true })]) {
    let message = ''
    try { await operation() } catch (error) { message = (error as Error).message }
    expect(message).not.toBe('')
    expect(message).not.toContain(secret)
    expect(message).not.toContain(replacement)
    expect(message).not.toContain('private-secret-value')
    expect(await readFile(filename, 'utf8')).toBe(text)
  }
})

it('re-reads other credential writes after acquiring the shared provider lock', async () => {
  const { environment, filename } = await fixture()
  await mkdir(environment.DSH_HOME!, { recursive: true })
  let release!: () => void
  let acquired!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { acquired = resolve })
  const writer = withFileLock(filename, async () => {
    acquired()
    await held
    await writeFile(filename, 'version: 1\nrefs:\n  OTHER_KEY: concurrent\n', { mode: 0o600 })
  })
  await ready
  const joining = joinCluster(secret, { environment })
  release()
  await Promise.all([writer, joining])
  expect(parseCredentialsDocument(await readFile(filename, 'utf8'), filename).refs.get('OTHER_KEY')).toBe('concurrent')
})

it('concurrent first starts choose one persisted cluster', async () => {
  const { environment, filename } = await fixture()
  const clusters = await Promise.all(Array.from({ length: 5 }, () => ensureClusterCredential(environment)))
  expect(new Set(clusters.map(cluster => cluster.clusterId)).size).toBe(1)
  await bootProvider(filename)
})

it('independent processes starting together retain the same cluster', async () => {
  const { environment, filename } = await fixture()
  const root = environment.DSH_HOME!
  await copyClusterRuntime(root)
  const entry = join(root, 'ensure.mjs')
  await writeFile(entry, "import { ensureClusterCredential } from './agentharness-cluster.mjs'; console.log((await ensureClusterCredential()).clusterId)\n")
  const results = await Promise.all(Array.from({ length: 4 }, async () => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...environment, AGENTHARNESS_MESH_SECRET: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolveExit({ code, signal }) })
    })
    return { ...result, stdout: stdout.trim(), stderr }
  }))
  for (const result of results) {
    expect(result.signal).toBeNull()
    expect(result.code, result.stderr).toBe(0)
  }
  expect(new Set(results.map(result => result.stdout)).size).toBe(1)
  expect((await readClusterCredential(environment))?.clusterId).toBe(results[0]!.stdout)
  await bootProvider(filename)
})
