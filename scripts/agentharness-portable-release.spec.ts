import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collaborationBrowserUrl, renderMcpGuide } from './agentharness-portable-command.mjs'
import { createLanReleaseServer, detectLanAddress, parseLanArguments } from './agentharness-serve-lan-release.mjs'
import {
  inspectPortableArchive,
  parseStageArguments,
  portableTarget,
  renderInstallScript,
  renderPowerShellInstallScript,
  stagePortableRelease,
  validateReleaseBaseUrl,
} from './agentharness-stage-portable-release.mjs'

const commandScript = resolve(import.meta.dirname, 'agentharness-portable-command.mjs')
const clusterScript = resolve(import.meta.dirname, 'agentharness-cluster.mjs')
const TEST_CLUSTER_SECRET = 'test-cluster-secret-material-that-is-long-enough'
const temporaryDirectories: string[] = []
const runningServers: ReturnType<typeof createServer>[] = []

it('opens the authenticated portable Web URL on the AgentHarness collaboration screen', async () => {
  const directory = await temporaryDirectory('agentharness browser url ')
  const log = join(directory, 'server.log')
  await writeFile(log, 'dsh web: http://127.0.0.1:3080/?token=fixture-launch-token\n')
  expect(await collaborationBrowserUrl(log, 'http://127.0.0.1:3080'))
    .toBe('http://127.0.0.1:3080/?token=fixture-launch-token#agentharness=collaboration')
})

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(server => new Promise<void>((resolvePromise) => {
    server.close(() => { resolvePromise() })
  })))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'agentharness release test '): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not receive a TCP port')
  await new Promise<void>((resolvePromise) => {
    server.close(() => { resolvePromise() })
  })
  return address.port
}

async function portableArchive(root: string, version = '1.2.3', platform = process.platform, arch = process.arch): Promise<string> {
  const payload = join(root, 'payload')
  await mkdir(join(payload, 'runtime'), { recursive: true })
  const runtimeName = platform === 'win32' ? 'node.exe' : 'node'
  await writeFile(join(payload, 'runtime', runtimeName), platform === 'win32' ? 'fake PE runtime' : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 })
  await cp(commandScript, join(payload, 'agentharness.mjs'))
  await cp(clusterScript, join(payload, 'agentharness-cluster.mjs'))
  await writeFile(join(payload, 'start.mjs'), '')
  await writeFile(join(payload, 'mcp.mjs'), '')
  await writeFile(join(payload, 'agentharness-portable.json'), `${JSON.stringify({
    formatVersion: 1,
    product: 'AgentHarness',
    version,
    platform,
    arch,
    entry: 'start.mjs',
    mcpEntry: 'mcp.mjs',
    runtime: { node: `runtime/${runtimeName}` },
  })}\n`)
  const archive = join(root, `agentharness-${platform}-${arch}.tgz`)
  execFileSync('tar', ['-czf', archive, '-C', payload, '.'])
  return archive
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  runningServers.push(server)
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolvePromise)
  })
}

async function runShell(command: string, env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn('sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const status = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { resolvePromise(code ?? 1) })
  })
  return { status, stdout, stderr }
}

describe('AgentHarness portable release staging', () => {
  it('accepts HTTPS and explicit private LAN HTTP only', () => {
    expect(validateReleaseBaseUrl('https://downloads.example.test/agentharness/')).toBe('https://downloads.example.test/agentharness')
    expect(validateReleaseBaseUrl('http://192.168.8.4:4177/token')).toBe('http://192.168.8.4:4177/token')
    expect(() => validateReleaseBaseUrl('http://example.com/agentharness')).toThrow('HTTPS')
    expect(() => validateReleaseBaseUrl('https://user:secret@example.com/agentharness')).toThrow('credentials')
    expect(portableTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(portableTarget('win32', 'x64')).toBe('win32-x64')
    expect(() => portableTarget('win32', 'arm64')).toThrow('unsupported portable target')
    expect(() => renderInstallScript({
      baseUrl: 'https://downloads.example.test/agentharness',
      version: '../bad',
      clusterSecret: TEST_CLUSTER_SECRET,
      artifacts: { 'darwin-arm64': { file: 'agentharness-darwin-arm64.tgz', sha256: 'a'.repeat(64), size: 42 } },
    })).toThrow('invalid portable version')
  })

  it('renders a pinned installer and copy-ready MCP guide', () => {
    const installer = renderInstallScript({
      baseUrl: 'http://10.0.0.8:4177/abcdefghijkl',
      version: '1.2.3',
      clusterSecret: TEST_CLUSTER_SECRET,
      artifacts: {
        'darwin-arm64': { file: 'agentharness-darwin-arm64.tgz', sha256: 'a'.repeat(64), size: 42 },
        'linux-x64': { file: 'agentharness-linux-x64.tgz', sha256: 'b'.repeat(64), size: 42 },
      },
    })
    expect(installer).toContain("base_url='http://10.0.0.8:4177/abcdefghijkl'")
    expect(installer).toContain("expected_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")
    expect(installer).toContain('no AgentHarness $version artifact was published for $target')
    expect(installer).toContain('"$command_path" start')
    expect(installer).toContain('"$command_path" mcp-setup')
    const powershell = renderPowerShellInstallScript({
      baseUrl: 'https://downloads.example.test/agentharness',
      version: '1.2.3',
      artifacts: { 'win32-x64': { file: 'agentharness-win32-x64.tgz', sha256: 'c'.repeat(64), size: 42 } },
    })
    expect(powershell).toContain("$BaseUrl = 'https://downloads.example.test/agentharness'")
    expect(powershell).toContain('Read-Host "AgentHarness cluster join secret" -AsSecureString')
    expect(powershell).toContain('Get-FileHash -Algorithm SHA256')
    expect(powershell).toContain('& $CommandPath mcp-setup')
    const guide = renderMcpGuide('/opt/AgentHarness/current', 4080)
    expect(guide).toContain('/opt/AgentHarness/current/runtime/node')
    expect(guide).toContain('codex mcp add agentharness')
    expect(guide).toContain('claude mcp add --scope user agentharness')
    expect(guide).toContain('agentharness_task_list')
  })

  it('stages separate shell and PowerShell installers for one cross-platform release', async () => {
    const fixture = await temporaryDirectory('agentharness cross platform release ')
    const hostArchive = await portableArchive(join(fixture, 'host'))
    const windowsArchive = await portableArchive(join(fixture, 'windows'), '1.2.3', 'win32', 'x64')
    const site = join(fixture, 'site')
    const staged = await stagePortableRelease({
      artifacts: [hostArchive, windowsArchive],
      out: site,
      baseUrl: 'https://downloads.example.test/agentharness',
    })
    expect(staged.installers).toEqual({
      shell: join(site, 'install.sh'),
      powershell: join(site, 'install.ps1'),
    })
    expect(await readFile(join(site, 'install.sh'), 'utf8')).not.toContain('win32-x64)')
    expect(await readFile(join(site, 'install.ps1'), 'utf8')).not.toContain(TEST_CLUSTER_SECRET)
    expect(staged.manifest.artifacts).toHaveProperty('win32-x64')
  })

  it('keeps public installers free of cluster credentials and persists a supplied join secret', async () => {
    const fixture = await temporaryDirectory('agentharness public release ')
    const archive = await portableArchive(fixture)
    const port = await freePort()
    const token = 'publicrelease1234'
    const site = join(fixture, 'site')
    const baseUrl = `http://127.0.0.1:${port}/${token}`
    const staged = await stagePortableRelease({ artifacts: [archive], out: site, baseUrl })
    const installer = await readFile(staged.installer, 'utf8')
    expect(staged.credential).toEqual({ mode: 'prompt' })
    expect(staged.manifest).toMatchObject({ formatVersion: 3, credential: { mode: 'prompt' } })
    expect(installer).not.toContain(TEST_CLUSTER_SECRET)
    expect(installer).toContain('AgentHarness cluster join secret (input hidden)')
    await listen(createLanReleaseServer(staged.output, token), port)
    const home = join(fixture, 'home')
    const env = {
      ...process.env,
      HOME: home,
      AGENTHARNESS_MESH_SECRET: TEST_CLUSTER_SECRET,
      AGENTHARNESS_NO_START: '1',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    }
    const installed = await runShell(`curl -fsSL ${baseUrl}/install.sh | sh`, env)
    expect(installed.status).toBe(0)
    expect(installed.stdout).toContain('Joined AgentHarness cluster')
    const credentials = await readFile(join(home, '.dsh', '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('AGENTHARNESS_MESH_SECRET')
    expect(credentials).toContain(JSON.stringify(TEST_CLUSTER_SECRET))
  })

  it('stages and installs twice through the exact curl pipe without Git, pnpm, or system Node', async () => {
    const fixture = await temporaryDirectory()
    const archive = await portableArchive(fixture)
    const inspection = await inspectPortableArchive(archive)
    expect(inspection.target).toBe(`${process.platform}-${process.arch}`)
    const port = await freePort()
    const token = 'abcdefghijklmnop'
    const site = join(fixture, 'site')
    const baseUrl = `http://127.0.0.1:${port}/${token}`
    const staged = await stagePortableRelease({ artifacts: [archive], out: site, baseUrl, clusterSecret: TEST_CLUSTER_SECRET })
    await listen(createLanReleaseServer(staged.output, token), port)
    const home = join(fixture, 'home with spaces')
    const data = join(home, 'data with spaces')
    const bin = join(home, 'bin with spaces')
    await mkdir(home, { recursive: true })
    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: data,
      AGENTHARNESS_BIN_DIR: bin,
      AGENTHARNESS_NO_START: '1',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    }
    const command = `curl -fsSL ${baseUrl}/install.sh | sh`
    const first = await runShell(command, env)
    expect(first.status).toBe(0)
    expect(first.stderr).toContain('trusted-LAN HTTP')
    expect(first.stdout).toContain('Installed AgentHarness 1.2.3')
    expect(first.stdout).toContain('MCP setup')
    expect(first.stdout).toContain('Codex:')
    expect(first.stdout).toContain('Joined AgentHarness cluster')
    expect((await lstat(join(home, '.dsh', '.credentials.yaml'))).mode & 0o077).toBe(0)
    const currentBefore = await readlink(join(data, 'agentharness', 'current'))
    const second = await runShell(command, env)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('Installed AgentHarness 1.2.3')
    expect(await readlink(join(data, 'agentharness', 'current'))).toBe(currentBefore)
    expect((await lstat(join(bin, 'agentharness'))).mode & 0o111).not.toBe(0)

    const upgradeRoot = join(fixture, 'upgrade')
    const upgradeArchive = await portableArchive(upgradeRoot, '1.2.4')
    const upgradePort = await freePort()
    const upgradeToken = 'ponmlkjihgfedcba'
    const upgradeSite = join(fixture, 'upgrade-site')
    const upgradeBaseUrl = `http://127.0.0.1:${upgradePort}/${upgradeToken}`
    const upgrade = await stagePortableRelease({
      artifacts: [upgradeArchive],
      out: upgradeSite,
      baseUrl: upgradeBaseUrl,
      clusterSecret: TEST_CLUSTER_SECRET,
    })
    await listen(createLanReleaseServer(upgrade.output, upgradeToken), upgradePort)
    const upgraded = await runShell(`curl -fsSL ${upgradeBaseUrl}/install.sh | sh`, env)
    expect(upgraded.status).toBe(0)
    expect(upgraded.stdout).toContain('Installed AgentHarness 1.2.4')
    expect(await readlink(join(data, 'agentharness', 'current'))).toContain('versions/1.2.4-')
  })

  it('leaves the active version untouched when the archive checksum is wrong', async () => {
    const fixture = await temporaryDirectory('agentharness release negative ')
    const archive = await portableArchive(fixture)
    const port = await freePort()
    const token = 'abcdefghijklmnop'
    const site = join(fixture, 'site')
    const baseUrl = `http://127.0.0.1:${port}/${token}`
    const staged = await stagePortableRelease({ artifacts: [archive], out: site, baseUrl, clusterSecret: TEST_CLUSTER_SECRET })
    await listen(createLanReleaseServer(staged.output, token), port)
    const home = join(fixture, 'home')
    const env = {
      ...process.env,
      HOME: home,
      AGENTHARNESS_NO_START: '1',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    }
    const command = `curl -fsSL ${baseUrl}/install.sh | sh`
    expect((await runShell(command, env)).status).toBe(0)
    const currentPath = join(home, '.local', 'share', 'agentharness', 'current')
    const currentBefore = await readlink(currentPath)
    const artifactPath = join(site, 'releases', staged.version, staged.manifest.artifacts[`${process.platform}-${process.arch}`]!.file)
    await appendFile(artifactPath, 'corrupt')
    const result = await runShell(command, env)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('checksum mismatch')
    expect(await readlink(currentPath)).toBe(currentBefore)
  })

  it('refuses to replace a staging directory it does not own', async () => {
    const fixture = await temporaryDirectory('agentharness release ownership ')
    const archive = await portableArchive(fixture)
    const output = join(fixture, 'existing')
    await mkdir(output)
    await writeFile(join(output, 'keep.txt'), 'user data')
    await expect(stagePortableRelease({
      artifacts: [archive],
      out: output,
      baseUrl: 'http://127.0.0.1:4177/abcdefghijkl',
      clusterSecret: TEST_CLUSTER_SECRET,
    })).rejects.toThrow('unowned release output')
    expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('user data')
  })
})

describe('AgentHarness LAN release server and installed command', () => {
  it('detects private LAN addresses and rejects path traversal', async () => {
    expect(detectLanAddress({
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }],
      en0: [{ address: '192.168.9.7', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.9.7/24' }],
    })).toBe('192.168.9.7')
    expect(parseLanArguments(['--', '--port', '4999', '--token', 'abcdefghijkl'])).toMatchObject({ port: 4999, token: 'abcdefghijkl' })
    expect(parseStageArguments([
      '--', '--artifact', '/tmp/agentharness.tgz', '--base-url', 'http://127.0.0.1:4999/abcdefghijkl',
    ])).toMatchObject({
      artifacts: [resolve('/tmp/agentharness.tgz')],
      baseUrl: 'http://127.0.0.1:4999/abcdefghijkl',
    })
    const fixture = await temporaryDirectory('agentharness server test ')
    await writeFile(join(fixture, 'install.sh'), 'ok')
    const port = await freePort()
    await listen(createLanReleaseServer(fixture, 'abcdefghijkl'), port)
    expect(await (await fetch(`http://127.0.0.1:${port}/abcdefghijkl/install.sh`)).text()).toBe('ok')
    expect((await fetch(`http://127.0.0.1:${port}/abcdefghijkl/%2e%2e/package.json`)).status).toBe(404)
  })

  it('starts, reports, and stops a detached packed runtime', async () => {
    const fixture = await temporaryDirectory('agentharness command test ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable, { recursive: true })
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await cp(clusterScript, join(portable, 'agentharness-cluster.mjs'))
    await writeFile(join(portable, 'agentharness-portable.json'), JSON.stringify({ product: 'AgentHarness', version: '9.8.7' }))
    await writeFile(join(portable, 'start.mjs'), [
      'import { createServer } from \'node:http\'',
      'const args = process.argv.slice(2)',
      'const index = args.findIndex(value => value === \'--port\')',
      'const port = Number(index === -1 ? 3080 : args[index + 1])',
      'const server = createServer((_request, response) => response.end(\'ready\'))',
      'server.listen(port, \'127.0.0.1\')',
      'const close = () => server.close(() => process.exit(0))',
      'process.on(\'SIGINT\', close)',
      'process.on(\'SIGTERM\', close)',
      '',
    ].join('\n'))
    const port = await freePort()
    const env = {
      ...process.env,
      AGENTHARNESS_RUNTIME_DIR: state,
      AGENTHARNESS_NO_OPEN: '1',
      AGENTHARNESS_PORT: String(port),
      DSH_HOME: join(fixture, 'dsh-home'),
    }
    const installedCommand = join(portable, 'agentharness.mjs')
    try {
      const started = execFileSync(process.execPath, [installedCommand, 'start'], { env, encoding: 'utf8' })
      expect(started).toContain(`AgentHarness 9.8.7 is ready at http://127.0.0.1:${port}`)
      expect(execFileSync(process.execPath, [installedCommand, 'status'], { env, encoding: 'utf8' })).toContain('ready at')
      expect(execFileSync(process.execPath, [installedCommand, 'start'], { env, encoding: 'utf8' })).toContain('already running')
      expect(execFileSync(process.execPath, [installedCommand, 'mcp-guide'], { env, encoding: 'utf8' })).toContain(`http://127.0.0.1:${port}`)
      const joined = spawnSync(process.execPath, [installedCommand, 'cluster', 'join', '--secret-stdin'], {
        env,
        encoding: 'utf8',
        input: `${TEST_CLUSTER_SECRET}\n`,
      })
      expect(joined.status).toBe(0)
      expect(joined.stdout).not.toContain(TEST_CLUSTER_SECRET)
      const rejoined = spawnSync(process.execPath, [installedCommand, 'cluster', 'join', '--secret-stdin'], {
        env,
        encoding: 'utf8',
        input: `${TEST_CLUSTER_SECRET}\n`,
      })
      expect(rejoined.status).toBe(0)
      expect(rejoined.stdout).toContain('Already joined')
      expect(rejoined.stdout).not.toContain('Restart AgentHarness')
      const clusterStatus = execFileSync(process.execPath, [installedCommand, 'cluster', 'status'], { env, encoding: 'utf8' })
      expect(clusterStatus).toContain('Fingerprint: sha256:')
      expect(clusterStatus).not.toContain(TEST_CLUSTER_SECRET)
    } finally {
      execFileSync(process.execPath, [installedCommand, 'stop'], { env, encoding: 'utf8' })
    }
    expect(spawnSync(process.execPath, [installedCommand, 'status'], { env, encoding: 'utf8' }).status).not.toBe(0)

    const occupiedPort = await freePort()
    await listen(createServer((_request, response) => response.end('unmanaged')), occupiedPort)
    const occupied = await runShell(`${JSON.stringify(process.execPath)} ${JSON.stringify(installedCommand)} start`, {
      ...env,
      AGENTHARNESS_PORT: String(occupiedPort),
    })
    expect(occupied.status).not.toBe(0)
    expect(occupied.stderr).toContain(`port ${occupiedPort} already has a responding HTTP service`)
    expect(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text()).toBe('unmanaged')
  })

  it('bounds restart time when an old page keeps the previous runtime alive', async () => {
    const fixture = await temporaryDirectory('agentharness open page upgrade ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable, { recursive: true })
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await cp(clusterScript, join(portable, 'agentharness-cluster.mjs'))
    await writeFile(join(portable, 'agentharness-portable.json'), JSON.stringify({ product: 'AgentHarness', version: '9.8.8' }))
    await writeFile(join(portable, 'start.mjs'), [
      'import { createServer } from \'node:http\'',
      'const args = process.argv.slice(2)',
      'const index = args.findIndex(value => value === \'--port\')',
      'const port = Number(index === -1 ? 3080 : args[index + 1])',
      'const server = createServer((request, response) => {',
      '  if (request.url === \'/open-page\') return',
      '  response.end(\'ready\')',
      '})',
      'server.listen(port, \'127.0.0.1\')',
      'process.on(\'SIGTERM\', () => { server.close() })',
      '',
    ].join('\n'))
    const port = await freePort()
    const env = {
      ...process.env,
      AGENTHARNESS_RUNTIME_DIR: state,
      AGENTHARNESS_NO_OPEN: '1',
      AGENTHARNESS_PORT: String(port),
    }
    const installedCommand = join(portable, 'agentharness.mjs')
    execFileSync(process.execPath, [installedCommand, 'start'], { env, encoding: 'utf8' })
    const openPage = connect(port, '127.0.0.1')
    await new Promise<void>((resolvePromise, reject) => {
      openPage.once('connect', resolvePromise)
      openPage.once('error', reject)
    })
    openPage.write('GET /open-page HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
    const startedAt = Date.now()
    try {
      expect(execFileSync(process.execPath, [installedCommand, 'stop'], { env, encoding: 'utf8' }))
        .toContain('AgentHarness stopped')
      expect(Date.now() - startedAt).toBeLessThan(6_000)
    } finally {
      openPage.destroy()
      spawnSync(process.execPath, [installedCommand, 'stop'], { env, encoding: 'utf8' })
    }
  })
})
