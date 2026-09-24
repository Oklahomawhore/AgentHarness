/** Release checks run without workspace dependencies on clean GitHub runners. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStageArguments, renderInstallScript, renderPowerShellInstallScript, stagePortableRelease } from './agentharness-stage-portable-release.mjs'
import { assertReleaseCommitOnMain, versionFromReleaseRef } from './agentharness-release-ref.mjs'

const baseUrl = 'https://github.com/Oklahomawhore/AgentHarness'
const artifacts = Object.fromEntries(['darwin-arm64', 'linux-x64', 'win32-x64'].map(target => [target, { file: `agentharness-${target}.tgz`, sha256: 'a'.repeat(64), size: 10 }]))
test('AgentHarness release identity accepts only stable version tags', () => {
  assert.equal(versionFromReleaseRef('refs/tags/v0.1.9'), '0.1.9')
  for (const ref of ['refs/heads/main', 'refs/tags/v0.01.9', 'refs/tags/v0.1.9-rc.1', 'refs/tags/vnext']) {
    assert.throws(() => versionFromReleaseRef(ref), /stable vMAJOR\.MINOR\.PATCH tag/)
  }
})
test('AgentHarness release commit must be checked out and reachable from main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentharness-release-ref-'))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git('init', '-q')
    git('symbolic-ref', 'HEAD', 'refs/heads/main')
    git('config', 'user.name', 'AgentHarness Test')
    git('config', 'user.email', 'agentharness-test@example.invalid')
    await writeFile(join(root, 'release.txt'), 'base\n')
    git('add', 'release.txt')
    git('commit', '-qm', 'base')
    const baseCommit = git('rev-parse', 'HEAD')
    git('switch', '-q', '-c', 'release/2026-09-23')
    await writeFile(join(root, 'release.txt'), 'candidate\n')
    git('commit', '-qam', 'candidate')
    const candidate = git('rev-parse', 'HEAD')
    assert.throws(() => assertReleaseCommitOnMain(candidate, { cwd: root, mainRef: 'main' }), /not reachable from main/)
    assert.throws(() => assertReleaseCommitOnMain(baseCommit, { cwd: root, mainRef: 'main' }), /differs from checked-out commit/)
    git('switch', '-q', 'main')
    git('merge', '--no-ff', '-qm', 'merge release', 'release/2026-09-23')
    assert.doesNotThrow(() => assertReleaseCommitOnMain(git('rev-parse', 'HEAD'), { cwd: root, mainRef: 'main' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('GitHub downloads pin a release tag on both installer platforms', () => {
  const options = { baseUrl, version: '0.1.7', artifacts, artifactBaseUrl: `${baseUrl}/releases/download/v0.1.7` }
  for (const render of [renderInstallScript, renderPowerShellInstallScript]) {
    const script = render(options)
    assert.ok(script.includes(`${baseUrl}/releases/download/v0.1.7/`) || script.includes(`${baseUrl}/releases/download/v0.1.7'`))
    assert.ok(script.includes('a'.repeat(64)))
    assert.throws(() => render({ ...options, artifactBaseUrl: 'http://untrusted.example.com' }), /HTTPS/)
    assert.ok(render({ ...options, artifactBaseUrl: undefined }).includes(`${baseUrl}/releases/0.1.7`))
  }
})
test('GitHub staging rejects origins before reading artifacts', async () => {
  const parsed = parseStageArguments(['--artifact', 'missing.tgz', '--base-url', 'https://example.com', '--github'])
  assert.equal(parsed.github, true)
  await assert.rejects(stagePortableRelease(parsed), /GitHub repository URL/)
})
test('staging generates a packable npm bootstrap with matching GitHub URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentharness-github-release-'))
  try {
    const payload = join(root, 'payload')
    await mkdir(payload)
    await writeFile(join(payload, 'agentharness-portable.json'), JSON.stringify({ product: 'AgentHarness', version: '0.1.7', platform: 'linux', arch: 'x64', runtime: { node: 'runtime/node' } }))
    const archive = join(root, 'portable.tgz')
    const tar = spawnSync('tar', ['-czf', archive, '-C', payload, '.'], { encoding: 'utf8' })
    assert.equal(tar.status, 0, tar.stderr)
    const output = join(root, 'release')
    const stage = spawnSync(process.execPath, [join(import.meta.dirname, 'agentharness-stage-npx.mjs'), '--github', '--base-url', baseUrl, '--artifact', archive, '--out', output], { encoding: 'utf8' })
    assert.equal(stage.status, 0, stage.stderr)
    const pkg = JSON.parse(await readFile(join(output, 'npm/package.json'), 'utf8'))
    assert.equal(pkg.name, '@sandboxbreak/agentharness')
    assert.equal(pkg.version, '0.1.7')
    assert.deepEqual(pkg.bin, { agentharness: 'bin.mjs' })
    assert.equal(pkg.author, 'Wangshu Zhu')
    const pack = spawnSync('npm', ['pack', './npm', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: output, encoding: 'utf8' })
    assert.equal(pack.status, 0, pack.stderr)
    const packed = JSON.parse(pack.stdout)[0].filename
    const manifest = spawnSync('tar', ['-xOf', join(root, packed), 'package/package.json'], { encoding: 'utf8' })
    assert.equal(manifest.status, 0, manifest.stderr)
    assert.equal(JSON.parse(manifest.stdout).name, pkg.name)
    assert.ok((await readFile(join(output, 'npm/install.sh'), 'utf8')).includes('releases/download/v0.1.7'))
    const version = spawnSync(process.execPath, [join(output, 'npm/bin.mjs'), '--version'], { encoding: 'utf8' })
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout.trim(), '0.1.7')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
