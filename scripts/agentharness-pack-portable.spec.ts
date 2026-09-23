import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePortableArguments, portableCommand, prunePortableSources, validatePortableOutput, verifyPortablePayload } from './agentharness-pack-portable.mjs'
import { portableEnvironment, portableWebArguments } from './agentharness-portable-start.mjs'

const script = resolve(import.meta.dirname, 'agentharness-pack-portable.mjs')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function portableFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentharness-portable-test-'))
  temporaryDirectories.push(root)
  for (const path of [
    'lib/bin.js',
    'runtime/node',
    'runtime/NODE_LICENSE',
    'agentharness.mjs',
    'agentharness-cluster.mjs',
    'agentharness-node-identity.mjs',
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    'node_modules/@deepseek-ai/dsh-web-app/package.json',
    'node_modules/@deepseek-ai/dsh-agentharness-bridge/lib/bin.js',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), '{}')
  }
  return root
}

describe('AgentHarness portable release', () => {
  it('parses an explicit output and safe defaults', () => {
    expect(parsePortableArguments(['--out', '/tmp/agentharness-artifact', '--skip-build'])).toEqual({
      out: '/tmp/agentharness-artifact', target: `${process.platform}-${process.arch}`, runtimeExecutable: undefined, runtimeLicense: undefined, skipBuild: true, dryRun: false,
    })
    expect(parsePortableArguments([
      '--target', 'win32-x64', '--runtime-executable', '/tmp/node.exe', '--runtime-license', '/tmp/LICENSE',
    ])).toMatchObject({ target: 'win32-x64', runtimeExecutable: '/tmp/node.exe', runtimeLicense: '/tmp/LICENSE' })
    expect(() => parsePortableArguments(['--target', 'win32-x64'])).toThrow('cross-platform packaging requires')
    expect(parsePortableArguments(['--', '--skip-build']).skipBuild).toBe(true)
    expect(() => parsePortableArguments(['--out'])).toThrow('--out needs a directory')
    expect(() => validatePortableOutput(resolve(import.meta.dirname, '..'))).toThrow('repository root')
  })

  it('runs pnpm through its JavaScript entry point on Windows', () => {
    expect(portableCommand('pnpm', ['run', 'build'], 'win32', 'C:\\setup-pnpm\\node_modules\\.bin')).toEqual({
      command: process.execPath,
      args: [resolve('C:\\setup-pnpm\\node_modules\\.bin', '..', 'pnpm', 'bin', 'pnpm.cjs'), 'run', 'build'],
    })
    expect(() => portableCommand('pnpm', ['run', 'build'], 'win32', '')).toThrow('PNPM_HOME is required')
    expect(portableCommand('pnpm', ['run', 'build'], 'linux', undefined)).toEqual({ command: 'pnpm', args: ['run', 'build'] })
  })

  it('starts a private Web profile unless the operator supplies explicit values', () => {
    expect(portableWebArguments([])).toEqual(['web', '--host', '127.0.0.1', '--port', '3080'])
    expect(portableWebArguments(['--host=127.0.0.1', '--port', '4080'])).toEqual([
      'web', '--host=127.0.0.1', '--port', '4080',
    ])
    expect(portableEnvironment({}).AGENTHARNESS_PROVIDER_BASE_URL).toBe('https://ark.cn-beijing.volces.com/api/coding/v3')
    expect(portableEnvironment({ AGENTHARNESS_PROVIDER_BASE_URL: 'https://gateway.example/v1' }).AGENTHARNESS_PROVIDER_BASE_URL)
      .toBe('https://gateway.example/v1')
    expect(portableEnvironment({})).not.toHaveProperty('AGENTHARNESS_PROVIDER_API_KEY')
  })

  it('accepts a complete source-free payload and rejects workspace source', async () => {
    const fixture = await portableFixture()
    const fixtureClosure = ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-agentharness-bridge']
    await expect(verifyPortablePayload(fixture, fixtureClosure)).resolves.toBeUndefined()
    await rm(join(fixture, 'agentharness-node-identity.mjs'))
    await expect(verifyPortablePayload(fixture, fixtureClosure)).rejects.toThrow('stable collaboration node identity')
    await writeFile(join(fixture, 'agentharness-node-identity.mjs'), '{}')
    await expect(verifyPortablePayload(fixture, [...fixtureClosure, '@deepseek-ai/dsh-missing']))
      .rejects.toThrow('workspace runtime packages')
    await mkdir(join(fixture, 'node_modules/@deepseek-ai/dsh-web-app/src'), { recursive: true })
    await expect(verifyPortablePayload(fixture, fixtureClosure)).rejects.toThrow('workspace source')
    await prunePortableSources(fixture)
    await expect(verifyPortablePayload(fixture, fixtureClosure)).resolves.toBeUndefined()
  })

  it('requires the target-specific bundled runtime filename', async () => {
    const fixture = await portableFixture()
    const fixtureClosure = ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-agentharness-bridge']
    await expect(verifyPortablePayload(fixture, fixtureClosure, 'win32-x64')).rejects.toThrow('bundled Node runtime')
    await writeFile(join(fixture, 'runtime', 'node.exe'), '{}')
    await expect(verifyPortablePayload(fixture, fixtureClosure, 'win32-x64')).rejects.toThrow('native packages')
    for (const path of [
      '@img/sharp-win32-x64',
      '@koromix/koffi-win32-x64',
      '@vscode/ripgrep-win32-x64',
      'node-addon-require-builtin-win32-x64-msvc',
    ]) await mkdir(join(fixture, 'node_modules', path), { recursive: true })
    await expect(verifyPortablePayload(fixture, fixtureClosure, 'win32-x64')).resolves.toBeUndefined()
  })

  it('dry-runs without building or writing an artifact', () => {
    const output = execFileSync(process.execPath, [script, '--dry-run', '--skip-build', '--out', '/tmp/agentharness-portable-dry-run'], { encoding: 'utf8' })
    expect(output).toContain('"pnpm" "--filter" "@deepseek-ai/dsh" "deploy"')
    expect(output).toContain('"--config.inject-workspace-packages=true"')
    expect(output).toContain('"--config.strict-dep-builds=false"')
    expect(output).not.toContain('"--legacy"')
    expect(output).toContain('write portable launchers')
    expect(output).toContain('archive')
  })

  it('uses a link-free hoisted dependency graph for cross-built Windows archives', () => {
    const output = execFileSync(process.execPath, [
      script,
      '--dry-run',
      '--skip-build',
      '--target', 'win32-x64',
      '--runtime-executable', '/tmp/node.exe',
      '--runtime-license', '/tmp/LICENSE',
      '--out', '/tmp/agentharness-portable-windows-dry-run',
    ], { encoding: 'utf8' })
    expect(output).toContain('"--config.node-linker=hoisted"')
    expect(output).toContain('agentharness-win32-x64.tgz')
  })

  it('executes the portable start entry through the installed current symlink', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'agentharness-portable-symlink-test-'))
    temporaryDirectories.push(fixture)
    const version = join(fixture, 'version')
    const home = join(fixture, 'home')
    await mkdir(join(version, 'lib'), { recursive: true })
    await mkdir(join(home, 'storages'), { recursive: true })
    await cp(resolve(import.meta.dirname, 'agentharness-portable-start.mjs'), join(version, 'start.mjs'))
    await cp(resolve(import.meta.dirname, 'agentharness-cluster.mjs'), join(version, 'agentharness-cluster.mjs'))
    await cp(resolve(import.meta.dirname, 'agentharness-node-identity.mjs'), join(version, 'agentharness-node-identity.mjs'))
    await writeFile(join(home, 'agentharness-node.json'), JSON.stringify({ version: 1, nodeId: 'agentharness-existing-node' }))
    await writeFile(join(home, 'storages', 'development_rooms.json'), JSON.stringify({
      unit: { name: 'development_rooms' },
      tables: { logs: { 'agentharness-existing-node': { entries: [{ nodeId: 'agentharness-existing-node', seq: 1 }] } } },
    }))
    await writeFile(join(version, 'lib', 'bin.js'), 'process.stdout.write(`${JSON.stringify({ args: process.argv.slice(2), nodeId: process.env.DSH_ROOM_NODE_ID })}\\n`)\n')
    await symlink(version, join(fixture, 'current'))
    const output = execFileSync(process.execPath, [join(fixture, 'current', 'start.mjs'), '--port', '4888'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
    }).trimEnd().split('\n')
    expect(output[0]).toMatch(
      /^AgentHarness local node: agentharness-existing-node; cluster: agentharness-[0-9a-f]{12} \(sha256:[0-9a-f]{16}\)$/u,
    )
    expect(JSON.parse(output[1] as string)).toEqual({
      args: ['web', '--host', '127.0.0.1', '--port', '4888'],
      nodeId: 'agentharness-existing-node',
    })
  })
})
