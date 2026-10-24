import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { copyClusterRuntime } from './agentharness-portable-fixture.ts'
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
const TEST_CLUSTER_SECRET = 'test-cluster-secret-material-that-is-long-enough'
const temporaryDirectories: string[] = []
const runningServers: ReturnType<typeof createServer>[] = []

it('opens the authenticated portable Web URL on the AgentHarness collaboration screen', async () => {
  const directory = await temporaryDirectory('agentharness browser url ')
  const log = join(directory, 'server.log')
  await writeFile(log, 'dsh web: http://127.0.0.1:3080/?token=fixture-launch-token\n')
  expect(await collaborationBrowserUrl(log, 'http://127.0.0.1:3080', 0))
    .toBe('http://127.0.0.1:3080/?token=fixture-launch-token#agentharness=collaboration')
})

it('selects the latest valid browser URL within the requested startup log interval', async () => {
  const directory = await temporaryDirectory('agentharness browser generation ')
  const log = join(directory, 'server.log')
  const origin = 'http://127.0.0.1:3080'
  const previous = `旧启动\ndsh web: ${origin}/?token=previous\n`
  await writeFile(log, previous)
  await expect(collaborationBrowserUrl(log, origin, Buffer.byteLength(previous))).rejects.toThrow('did not print')
  await appendFile(log, [
    `dsh web: ${origin}/?token=current`,
    'dsh web: http://[incomplete',
    'dsh web: http://127.0.0.1:3081/?token=another-host',
    `dsh web: ${origin}/`,
    '',
  ].join('\n'))
  expect(await collaborationBrowserUrl(log, origin, 0)).toBe(`${origin}/?token=current#agentharness=collaboration`)
  expect(await collaborationBrowserUrl(log, origin, Buffer.byteLength(previous)))
    .toBe(`${origin}/?token=current#agentharness=collaboration`)
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
  await copyClusterRuntime(payload)
  await writeFile(join(payload, 'start.mjs'), '')
  await writeFile(join(payload, 'agentharness-portable.json'), `${JSON.stringify({
    formatVersion: 1,
    product: 'AgentHarness',
    version,
    platform,
    arch,
    entry: 'start.mjs',
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
  // Match the Windows coverage lane's process-case budget; the child owns its earlier deadline.
  it.skipIf(process.platform !== 'win32')('PowerShell archive paths accept tar roots and reject escapes', () => {
    const cases = [
      { member: '.', rejected: false },
      { member: './', rejected: false },
      { member: './runtime/node.exe', rejected: false },
      { member: 'lib/.cache/file.js', rejected: false },
      { member: 'lib/..cache/file.js', rejected: false },
      { member: 'lib/file..js', rejected: false },
      { member: '目录/文件.js', rejected: false },
      { member: '..', rejected: true },
      { member: '../outside', rejected: true },
      { member: './lib/../../outside', rejected: true },
      { member: 'lib/..', rejected: true },
      { member: 'lib\\..\\outside', rejected: true },
      { member: '/outside', rejected: true },
      { member: '\\outside', rejected: true },
      { member: 'C:\\outside', rejected: true },
      { member: 'C:outside', rejected: true },
      { member: '\\\\server\\share', rejected: true },
    ]
    const installer = renderPowerShellInstallScript({
      baseUrl: 'https://downloads.example.test/agentharness', version: '1.2.3',
      artifacts: { 'win32-x64': { file: 'agentharness-win32-x64.tgz', sha256: 'c'.repeat(64), size: 42 } },
    })
    const start = installer.indexOf('  foreach ($Member in $Members) {')
    const end = installer.indexOf('  $Payload = ', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const encoded = Buffer.from(JSON.stringify(cases)).toString('base64')
    const script = [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      `$Cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
      '$Results = foreach ($Case in $Cases) {',
      '  $Members = @($Case.member)',
      '  $Rejected = $false',
      '  try {',
      installer.slice(start, end),
      '  } catch {',
      '    if ($_.Exception.Message -ne "archive contains an unsafe path: $($Case.member)") { throw }',
      '    $Rejected = $true',
      '  }',
      '  [pscustomobject]@{ member = $Case.member; rejected = $Rejected }',
      '}',
      'ConvertTo-Json -InputObject @($Results) -Compress',
    ].join('\n')
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30_000,
    })
    expect(JSON.parse(output) as unknown).toEqual(cases)
  }, 90_000)

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
    const guide = renderMcpGuide('/opt/AgentHarness/current', { DSH_HOME: '/private/harness-home' })
    if (process.platform === 'win32') {
      expect(guide).toContain('unsupported on Windows')
      expect(guide).not.toContain('mcp add')
      return
    }
    expect(guide).toContain('/opt/AgentHarness/current/runtime/node')
    expect(guide).toContain('codex mcp add agentharness')
    expect(guide).toContain('claude mcp add --env')
    expect(guide).toContain('--transport stdio --scope user agentharness')
    expect(guide).toContain('--profile mcp --connection')
    expect(guide).toContain('/private/harness-home/mcp/connection.json')
    expect(guide).toContain('DSH_HOME')
    expect(guide).not.toContain('mcp.mjs')
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
    expect(parseCredentialsDocument(credentials, 'installed credentials').refs.get('AGENTHARNESS_MESH_SECRET')).toBe(TEST_CLUSTER_SECRET)
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
  it('waits for this startup URL with HTTP ready, concurrent reuse, and a previous launch in the log', async () => {
    const fixture = await temporaryDirectory('agentharness startup generation ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable)
    await mkdir(state)
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await copyClusterRuntime(portable)
    await writeFile(join(portable, 'agentharness-portable.json'), JSON.stringify({ version: '9.8.7' }))
    // The bound fixture owns HTTP; each real runtime process opens a control stream before HTTP becomes ready.
    let control: import('node:http').ServerResponse | undefined
    let entered = Promise.withResolvers<import('node:http').ServerResponse>()
    const probes = new Map<string, { count: number; blocked: ReturnType<typeof Promise.withResolvers<undefined>> }>()
    const server = createServer((request, response) => {
      if (request.url === '/fixture-control') {
        control = response
        response.writeHead(200)
        response.flushHeaders()
        response.once('close', () => { if (control === response) control = undefined })
        entered.resolve(response)
        return
      }
      response.writeHead(control === undefined ? 503 : 401)
      response.end()
      const probe = probes.get(String(request.headers['x-fixture-client']))
      if (control !== undefined && probe !== undefined && ++probe.count === 3) probe.blocked.resolve(undefined)
    })
    await listen(server, 0)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture HTTP did not bind')
    const origin = `http://127.0.0.1:${String(address.port)}`
    const logPath = join(state, 'server.log')
    const stale = `old startup\ndsh web: ${origin}/?token=stale\n`
    await writeFile(logPath, stale)
    await writeFile(join(portable, 'start.mjs'), [
      "import { get } from 'node:http'",
      "import { createInterface } from 'node:readline'",
      'let stopping = false',
      'const request = get(`${process.env.AGENTHARNESS_URL}/fixture-control`, response => {',
      "  response.on('error', error => { if (!stopping) throw error })",
      "  createInterface({ input: response }).on('line', token => console.log(`dsh web: ${process.env.AGENTHARNESS_URL}/?token=${token}`))",
      '})',
      "request.on('error', error => { if (!stopping) throw error })",
      "process.on('SIGTERM', () => { stopping = true; request.destroy() })",
      '',
    ].join('\n'))
    // Preserve real HTTP requests while identifying each concurrent management process at the fixture server.
    const driver = join(portable, 'command-driver.mjs')
    await writeFile(driver, [
      "import { runInstalledCommand } from './agentharness.mjs'",
      'const nativeFetch = globalThis.fetch',
      'globalThis.fetch = (input, options) => {',
      '  const headers = new Headers(options?.headers)',
      "  headers.set('x-fixture-client', process.argv[2])",
      '  return nativeFetch(input, { ...options, headers })',
      '}',
      'await runInstalledCommand(process.argv.slice(3))',
      '',
    ].join('\n'))
    const env = { ...process.env, AGENTHARNESS_RUNTIME_DIR: state, AGENTHARNESS_PORT: String(address.port), AGENTHARNESS_NO_OPEN: '1' }
    type CommandResult = { code: number | null; signal: NodeJS.Signals | null; error: Error | undefined; stdout: string; stderr: string }
    const commands: { child: ReturnType<typeof spawn>; closed: Promise<CommandResult> }[] = []
    const run = (label: string, command: string) => {
      const blocked = Promise.withResolvers<undefined>()
      probes.set(label, { count: 0, blocked })
      const child = spawn(process.execPath, [driver, label, command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let error: Error | undefined
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (failure) => { error = failure })
      const closed = new Promise<CommandResult>((resolveClosed) => {
        child.once('close', (code, signal) => { resolveClosed({ code, signal, error, stdout, stderr }) })
      })
      commands.push({ child, closed })
      return { closed, blocked: Promise.race([blocked.promise.then(() => 'waiting'), closed.then(() => 'returned')]) }
    }
    try {
      const first = run('first', 'start')
      const firstControl = await entered.promise
      expect(await first.blocked).toBe('waiting')
      const pendingStatus = await run('pending-status', 'status').closed
      expect(pendingStatus).toMatchObject({ code: 1, signal: null, error: undefined })
      expect(pendingStatus.stdout).toContain('running without completed startup')
      const reuse = run('reuse', 'start')
      expect(await reuse.blocked).toBe('waiting')
      firstControl.write('first-generation\n')
      const results = await Promise.all([first.closed, reuse.closed])
      for (const result of results) expect(result).toMatchObject({ code: 0, signal: null, error: undefined, stderr: '' })
      expect(results[0]?.stdout).toContain('is ready at')
      expect(results[1]?.stdout).toContain('already running')
      const firstState = JSON.parse(await readFile(join(state, 'server.json'), 'utf8')) as { logOffset: number }
      expect(firstState.logOffset).toBe(Buffer.byteLength(stale))
      expect(await collaborationBrowserUrl(logPath, origin, firstState.logOffset))
        .toBe(`${origin}/?token=first-generation#agentharness=collaboration`)
      const { logOffset: _offset, ...legacyState } = firstState
      await writeFile(join(state, 'server.json'), JSON.stringify(legacyState))
      const legacy = await run('legacy', 'start').closed
      expect(legacy).toMatchObject({ code: 1, signal: null, error: undefined })
      expect(legacy.stderr).toContain('restart AgentHarness')
      entered = Promise.withResolvers<import('node:http').ServerResponse>()
      const restart = run('restart', 'restart')
      const secondControl = await entered.promise
      expect(await restart.blocked).toBe('waiting')
      secondControl.write('second-generation\n')
      expect(await restart.closed).toMatchObject({ code: 0, signal: null, error: undefined, stderr: '' })
      expect(await collaborationBrowserUrl(logPath, origin, 0))
        .toBe(`${origin}/?token=second-generation#agentharness=collaboration`)
    } finally {
      for (const { child } of commands) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await Promise.all(commands.map(command => command.closed))
      const stopped = spawnSync(process.execPath, [join(portable, 'agentharness.mjs'), 'stop'], { env, encoding: 'utf8' })
      server.closeAllConnections()
      expect(stopped.error).toBeUndefined()
      expect(stopped.signal).toBeNull()
      expect(stopped.status).toBe(0)
    }
  })

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

  it('reports this launch failure and exit code without stale log output or browser tokens', async () => {
    const fixture = await temporaryDirectory('agentharness failed start ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable, { recursive: true })
    await mkdir(state)
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await copyClusterRuntime(portable)
    await writeFile(join(portable, 'agentharness-portable.json'), JSON.stringify({ version: '9.8.7' }))
    await writeFile(join(state, 'server.log'), 'stale launch failure\n')
    await writeFile(join(portable, 'start.mjs'), [
      "console.error('credentials-local: unknown top-level key AGENTHARNESS_MESH_SECRET')",
      "console.error('dsh web: http://127.0.0.1:3080/?token=private-browser-token')",
      'process.exitCode = 7',
    ].join('\n'))
    // An owned bound socket reserves the port without answering the HTTP probe.
    const reservation = createServer()
    await listen(reservation, 0)
    const address = reservation.address()
    if (address === null || typeof address === 'string') throw new Error('port reservation failed')
    const child = spawn(process.execPath, [join(portable, 'agentharness.mjs'), 'start'], {
      env: { ...process.env, AGENTHARNESS_ACTIVE_ROOT: portable, AGENTHARNESS_RUNTIME_DIR: state, AGENTHARNESS_PORT: String(address.port), AGENTHARNESS_NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', resolveExit)
    })
    expect(code).toBe(1)
    await expect(stderr.replaceAll(join(state, 'server.log'), '<log>')).toMatchFileSnapshot('./tests/expected/agentharness-start-failure.txt')
    expect(stderr).toContain('exited before readiness (exit code 7)')
    expect(stderr).toContain('credentials-local: unknown top-level key AGENTHARNESS_MESH_SECRET')
    expect(stderr).not.toContain('stale launch failure')
    expect(stderr).not.toContain('private-browser-token')
    await expect(readFile(join(state, 'server.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([200, 401])('starts, reports, and stops its owned runtime with HTTP %s', async (httpStatus) => {
    const fixture = await temporaryDirectory('agentharness command test ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable, { recursive: true })
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await copyClusterRuntime(portable)
    await writeFile(join(portable, 'agentharness-portable.json'), JSON.stringify({ product: 'AgentHarness', version: '9.8.7' }))
    await writeFile(join(portable, 'start.mjs'), [
      'import { createServer } from \'node:http\'',
      'const args = process.argv.slice(2)',
      'const index = args.findIndex(value => value === \'--port\')',
      'const port = Number(index === -1 ? 3080 : args[index + 1])',
      `const server = createServer((_request, response) => { response.statusCode = ${String(httpStatus)}; response.end('ready') })`,
      'server.listen(port, \'127.0.0.1\', () => console.log(`dsh web: http://127.0.0.1:${port}/?token=fixture-launch-token`))',
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
      expect(execFileSync(process.execPath, [installedCommand, 'mcp-guide'], { env, encoding: 'utf8' }))
        .toContain(join(env.DSH_HOME, 'mcp', 'connection.json'))
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
    await listen(createServer((_request, response) => { response.statusCode = 401; response.end('unmanaged') }), occupiedPort)
    const occupied = await runShell(`${JSON.stringify(process.execPath)} ${JSON.stringify(installedCommand)} start`, {
      ...env,
      AGENTHARNESS_PORT: String(occupiedPort),
    })
    expect(occupied.status).not.toBe(0)
    expect(occupied.stderr).toContain(`port ${occupiedPort} already has a responding HTTP service`)
    expect(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text()).toBe('unmanaged')
  })

  it('rejects a live foreign PID even when its recorded port answers HTTP 401', async () => {
    const fixture = await temporaryDirectory('agentharness wrong owner ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable)
    await mkdir(state)
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await copyClusterRuntime(portable)
    await writeFile(join(portable, 'agentharness-portable.json'), JSON.stringify({ version: '9.8.7' }))
    const server = createServer((_request, response) => { response.statusCode = 401; response.end('foreign') })
    await listen(server, 0)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing server address')
    await writeFile(join(state, 'server.json'), JSON.stringify({
      pid: process.pid, entry: join(portable, 'start.mjs'), version: '9.8.7', port: address.port,
    }))
    const result = await runShell(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(portable, 'agentharness.mjs'))} start`, {
      ...process.env, AGENTHARNESS_RUNTIME_DIR: state, AGENTHARNESS_PORT: String(address.port), AGENTHARNESS_NO_OPEN: '1',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match the recorded AgentHarness entry')
    expect(result.stdout).not.toContain('already running')
    expect(await (await fetch(`http://127.0.0.1:${String(address.port)}`)).text()).toBe('foreign')
  })

  it('bounds restart time when an old page keeps the previous runtime alive', async () => {
    const fixture = await temporaryDirectory('agentharness open page upgrade ')
    const portable = join(fixture, 'portable')
    const state = join(fixture, 'state')
    await mkdir(portable, { recursive: true })
    await cp(commandScript, join(portable, 'agentharness.mjs'))
    await copyClusterRuntime(portable)
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
      'server.listen(port, \'127.0.0.1\', () => console.log(`dsh web: http://127.0.0.1:${port}/?token=fixture-launch-token`))',
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
