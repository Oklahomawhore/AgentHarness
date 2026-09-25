/** Public npm bootstrap checks use real subprocesses and a synthetic installer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
test('bootstrap preserves existing team input and creates fresh private cluster material', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentharness-npx-test-'))
  try {
    await cp(join(root, 'scripts/agentharness-npx-bin.mjs'), join(directory, 'bin.mjs'))
    await cp(join(root, 'scripts/agentharness-cluster.mjs'), join(directory, 'agentharness-cluster.mjs'))
    await cp(dirname(fileURLToPath(import.meta.resolve('yaml/package.json'))), join(directory, 'node_modules/yaml'), { recursive: true })
    await writeFile(join(directory, 'install.sh'), 'printf "%s" "$AGENTHARNESS_MESH_SECRET" > "$AGENTHARNESS_TEST_SECRET_FILE"\nexit "${AGENTHARNESS_TEST_EXIT:-0}"\n')
    const secretFile = join(directory, 'secret')
    const env = { ...process.env, DSH_HOME: directory, AGENTHARNESS_TEST_SECRET_FILE: secretFile, AGENTHARNESS_MESH_SECRET: '' }
    const run = (args = [], extra = {}) => spawnSync(process.execPath, [join(directory, 'bin.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' })
    const first = run()
    assert.equal(first.status, 0)
    const secret = await readFile(secretFile, 'utf8')
    assert.match(secret, /^[a-f0-9]{64}$/)
    assert.equal(first.stdout.includes(secret), false)
    assert.equal(run().status, 0)
    assert.notEqual(await readFile(secretFile, 'utf8'), secret)
    assert.equal(run([], { AGENTHARNESS_MESH_SECRET: 'test-team-secret' }).status, 0)
    assert.equal(await readFile(secretFile, 'utf8'), 'test-team-secret')
    const managed = 'persisted-private-cluster-material-from-an-earlier-install'
    await writeFile(join(directory, '.credentials.yaml'), `AGENTHARNESS_MESH_SECRET: ${JSON.stringify(managed)}\n`, { mode: 0o600 })
    assert.equal(run().status, 0)
    assert.equal(await readFile(secretFile, 'utf8'), managed)
    await writeFile(join(directory, '.credentials.yaml'), `version: 1\nrefs:\n  AGENTHARNESS_MESH_SECRET: ${JSON.stringify(managed)}\n`, { mode: 0o600 })
    assert.equal(run().status, 0)
    assert.equal(await readFile(secretFile, 'utf8'), managed)
    assert.equal(run([], { AGENTHARNESS_TEST_EXIT: '7' }).status, 7)
    assert.equal(run(['--unknown']).status, 1)
    assert.match(run(['--help']).stdout, /DeepSeek Harness/)
    assert.match(run(['--help']).stdout, /@sandboxbreak\/agentharness/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('public staging rejects embedded secrets and insecure origins before reading artifacts', () => {
  const run = args => spawnSync(process.execPath, [join(root, 'scripts/agentharness-stage-npx.mjs'), '--artifact', 'missing.tgz', ...args], { encoding: 'utf8' })
  const embedded = run(['--base-url', 'https://example.com', '--cluster-secret-file', 'secret'])
  assert.equal(embedded.status, 1)
  assert.match(embedded.stderr, /cannot embed/)
  const insecure = run(['--base-url', 'http://127.0.0.1:3000'])
  assert.equal(insecure.status, 1)
  assert.match(insecure.stderr, /require an HTTPS/)
})
test('public source export excludes history and environment files, and rejects copied credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentharness-public-export-test-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'scripts'))
    await cp(join(root, 'scripts/agentharness-export-public.mjs'), join(directory, 'scripts/agentharness-export-public.mjs'))
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q')
    const secret = 'test-credential-material-not-for-publication'
    await writeFile(join(directory, '.env'), `API_KEY=${secret}\n`)
    await writeFile(join(directory, '.env.example'), 'API_KEY=\n')
    await writeFile(join(directory, 'source.txt'), 'public source\n')
    git('add', '.')
    const run = output => spawnSync(process.execPath, [join(directory, 'scripts/agentharness-export-public.mjs'), output], { encoding: 'utf8' })
    assert.equal(run('dist/exported').status, 0)
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(directory, 'dist/exported/.env')), false)
    assert.equal(existsSync(join(directory, 'dist/exported/.git')), false)
    assert.equal(await readFile(join(directory, 'dist/exported/.env.example'), 'utf8'), 'API_KEY=\n')
    assert.equal(run('dist/exported').status, 1)
    await writeFile(join(directory, 'source.txt'), secret)
    const rejected = run('rejected')
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /potential credential/)
    assert.equal(rejected.stderr.includes(secret), false)
    assert.equal(existsSync(join(directory, 'rejected')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
