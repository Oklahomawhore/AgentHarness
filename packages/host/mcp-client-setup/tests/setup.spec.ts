import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpClientSetupService, listMcpClients, setupAllMcpClients, setupMcpClient, type McpClientSetupOptions } from '../src/index.ts'

const roots: string[] = []
const machine = vi.hoisted(() => ({ name: undefined as string | undefined }))
const writer = vi.hoisted(() => ({ beforeLock: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, withFileLock: async (...args: Parameters<typeof actual.withFileLock>) => {
    await writer.beforeLock?.(args[0])
    return actual.withFileLock(...args)
  } }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, hostname: () => machine.name ?? actual.hostname() }
})

afterEach(async () => {
  machine.name = undefined
  writer.beforeLock = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; options: McpClientSetupOptions }> {
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'agentharness-mcp-setup-'))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const apps = join(root, 'Applications')
  await Promise.all([mkdir(home), mkdir(bin), mkdir(apps)])
  return {
    root,
    options: {
      home,
      path: bin,
      environment: {
        CODEX_HOME: join(home, '.codex'),
        HOME: home,
        PATH: bin,
      },
      platform: 'darwin',
      username: 'Test User',
      nodePath: '/opt/agentharness/runtime/node',
      dshPath: '/opt/agentharness/lib/bin.js',
      nodeArgs: [],
      commandTimeoutMs: 10_000,
      descriptorPath: join(home, '.dsh', 'mcp', 'connection.json'),
      harnessHome: join(home, '.dsh'),
      applicationRoots: [apps],
    },
  }
}

async function fakeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

describe('MCP client setup', () => {
  it.each(['nodePath', 'dshPath', 'descriptorPath', 'harnessHome', 'sourceTsconfigPath'] as const)(
    'rejects relative deployment %s before inspecting clients', async (field) => {
      const { options } = await fixture()
      await expect(listMcpClients({ ...options, [field]: 'relative-path' })).rejects.toThrow('must be absolute')
    },
  )

  it.each([0, 2_147_483_648])('rejects an unsupported client-command deadline %s before inspection', async (commandTimeoutMs) => {
    const { options } = await fixture()
    const deployment = { ...options, commandTimeoutMs }
    await expect(listMcpClients(deployment)).rejects.toThrow('commandTimeoutMs')
  })

  // exec replaces the fixture shell, so command cancellation leaves no descendant timer process.
  it.skipIf(process.platform === 'win32')('bounds official client inspection by its configured deadline', async () => {
    const { root, options } = await fixture()
    await fakeExecutable(join(root, 'bin', 'codex'), '#!/bin/sh\nexec "$MCP_SETUP_NODE" -e \'setTimeout(() => process.stdout.write("[]"), 250)\'\n')
    const deployment = { ...options, commandTimeoutMs: 25,
      environment: { ...options.environment, MCP_SETUP_NODE: process.execPath } }
    const snapshot = await listMcpClients(deployment)
    expect(snapshot.clients.find(client => client.id === 'codex')).toMatchObject({
      detected: true, state: 'failed', canSetup: false,
      detail: 'Could not inspect Codex MCP settings; run codex mcp list --json locally for diagnostics.',
    })
  })

  it.skipIf(process.platform === 'win32')('bounds official registration without exposing command output', async () => {
    const { root, options } = await fixture()
    await fakeExecutable(join(root, 'bin', 'claude'), '#!/bin/sh\nexec "$MCP_SETUP_NODE" -e \'process.stdout.write("PRIVATE_COMMAND_OUTPUT"); setTimeout(() => {}, 2000)\'\n')
    const result = await setupMcpClient({ ...options, commandTimeoutMs: 100,
      environment: { ...options.environment, MCP_SETUP_NODE: process.execPath } }, { clientId: 'claude-code' })
    expect(result).toMatchObject({ outcome: 'failed', client: {
      state: 'failed', detail: 'Client MCP registration command failed.',
    } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_COMMAND_OUTPUT')
  })

  // Native shebang execution is POSIX-only; lookup and child PATH are both intentionally empty.
  it.skipIf(process.platform === 'win32')('runs an explicit executable with spaces without PATH or application discovery', async () => {
    const { root, options } = await fixture()
    const directory = join(root, 'private executables')
    await mkdir(directory)
    const command = join(directory, 'official codex')
    const log = join(root, 'override-invocation')
    await fakeExecutable(command, '#!/bin/sh\nprintf "%s" "$*" > "$MCP_SETUP_LOG"\nprintf "[]"\n')
    const listed = await listMcpClients({ ...options, path: '', applicationRoots: [], executableOverrides: { codex: command },
      environment: { ...options.environment, PATH: '', MCP_SETUP_LOG: log } })
    expect(listed.clients.find(client => client.id === 'codex')).toMatchObject({
      detected: true, state: 'not-configured', canSetup: true, restartRequired: false,
    })
    expect(listed.clients.filter(client => client.detected).map(client => client.id)).toEqual(['codex'])
    expect(await readFile(log, 'utf8')).toBe('mcp list --json')
  })

  it('keeps one account’s clients distinct across separate Hosts and stable on the same Host', async () => {
    const { options } = await fixture()
    machine.name = 'first-host'
    const first = await listMcpClients(options)
    machine.name = 'second-host'
    const second = await listMcpClients(options)
    machine.name = 'first-host'
    const again = await listMcpClients(options)
    expect(again.clients.map(client => client.participantId)).toEqual(first.clients.map(client => client.participantId))
    for (const client of first.clients) {
      expect(second.clients.find(item => item.id === client.id)?.participantId).not.toBe(client.participantId)
    }
  })

  it('retains distinct client identities when a deployment username exceeds the participant limit', async () => {
    const { root, options } = await fixture()
    const deployment = { ...options, username: 'long-deployment-user-'.repeat(8) }
    const listed = await listMcpClients(deployment)
    expect(new Set(listed.clients.map(client => client.participantId)).size).toBe(listed.clients.length)
    for (const client of listed.clients) {
      expect(client.participantId.length).toBeLessThanOrEqual(80)
      expect(client.participantId.endsWith(`-${client.id}`)).toBe(true)
    }
    for (const [clientId, application] of [['cursor', 'Cursor.app'], ['workbuddy', 'WorkBuddy.app']] as const) {
      await mkdir(join(root, 'Applications', application))
      const configured = await setupMcpClient(deployment, { clientId })
      expect(configured.outcome).toBe('configured')
      const document: unknown = JSON.parse(await readFile(join(root, 'home', `.${clientId}`, 'mcp.json'), 'utf8'))
      expect(document).toMatchObject({ mcpServers: { agentharness: { args: [
        options.dshPath, '--profile', 'mcp', '--connection', options.descriptorPath,
        '--participant-id', configured.client.participantId, '--display-name', configured.client.displayName,
      ] } } })
    }
  })

  it('detects clients independently and leaves unsupported clients manual-only', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    await mkdir(join(root, 'Applications', 'Doubao.app'))
    const snapshot = await listMcpClients(options)

    expect(snapshot.clients.find(client => client.id === 'cursor')).toMatchObject({ detected: true, state: 'not-configured', canSetup: true })
    expect(snapshot.clients.find(client => client.id === 'doubao')).toMatchObject({ detected: true, state: 'manual', canSetup: false })
    expect(snapshot.clients.find(client => client.id === 'claude-code')).toMatchObject({ detected: false, state: 'not-installed' })
  })

  // Windows setup is unsupported and creating symlinks can require elevated privileges.
  it.skipIf(process.platform === 'win32').each(['PATH', 'application bundle'] as const)(
    'isolates an executable symlink loop discovered through %s without changing client settings', async (location) => {
      const { root, options } = await fixture()
      const command = location === 'PATH' ? join(root, 'bin', 'codex')
        : join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex')
      if (location === 'application bundle') {
        await mkdir(join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Resources'), { recursive: true })
      }
      await symlink('codex', command)
      const codexConfig = join(root, 'home', '.codex', 'config.toml')
      await mkdir(join(root, 'home', '.codex'))
      const original = 'model = "retained-user-model"\n'
      await writeFile(codexConfig, original)
      const buddyConfig = join(root, 'home', '.workbuddy', 'mcp.json')
      await mkdir(join(root, 'home', '.workbuddy'))
      await writeFile(buddyConfig, JSON.stringify({ preference: 'retained', mcpServers: { sibling: { command: 'existing' } } }))
      const listed = await listMcpClients(options)
      expect(listed.clients.find(client => client.id === 'codex')).toMatchObject({ state: 'failed', canSetup: false })
      expect(listed.clients.find(client => client.id === 'workbuddy')).toMatchObject({ state: 'not-configured', canSetup: true })
      const results = await setupAllMcpClients(options)
      expect(results.find(result => result.client.id === 'codex')).toMatchObject({ outcome: 'failed', client: { state: 'failed' } })
      expect(results.find(result => result.client.id === 'workbuddy')?.outcome).toBe('configured')
      expect(await readlink(command)).toBe('codex')
      expect(await readFile(codexConfig, 'utf8')).toBe(original)
      expect(JSON.parse(await readFile(buddyConfig, 'utf8'))).toMatchObject({ preference: 'retained', mcpServers: {
        sibling: { command: 'existing' }, agentharness: { command: options.nodePath },
      } })
    },
  )

  // File-as-parent discovery reports platform-specific errors; MCP setup supports POSIX hosts.
  it.skipIf(process.platform === 'win32')('keeps configuration-only discovery independent when a client parent is not a directory', async () => {
    const { root, options } = await fixture()
    const blocked = join(root, 'home', '.cursor')
    await writeFile(blocked, 'preserved configuration parent')
    await mkdir(join(root, 'home', '.workbuddy'))
    await writeFile(join(root, 'home', '.workbuddy', 'mcp.json'), '{}')
    const result = await listMcpClients({ ...options, applicationRoots: [] })
    expect(result.clients.find(client => client.id === 'cursor')).toMatchObject({ state: 'failed', canSetup: false })
    expect(result.clients.find(client => client.id === 'workbuddy')).toMatchObject({ state: 'not-configured', canSetup: true })
    expect(await readFile(blocked, 'utf8')).toBe('preserved configuration parent')
  })

  // These bundled Codex fixtures exercise the executable and CLI-output boundary without a real client installation.
  it.skipIf(process.platform === 'win32').each([
    ['not an MCP list', '{}', 'failed'],
    ['different transport', '[{"name":"agentharness","transport":{"type":"http"}}]', 'conflict'],
    ['disabled different transport', '[{"name":"agentharness","enabled":false,"transport":{"type":"http"}}]', 'conflict'],
  ])('inspects a bundled official client reporting %s', async (_label, contents, state) => {
    const { root, options } = await fixture()
    const executable = join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex')
    await mkdir(join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Resources'), { recursive: true })
    await fakeExecutable(executable, '#!/bin/sh\nprintf "%s" "$MCP_SETUP_LIST"\n')
    const result = await listMcpClients({ ...options, environment: { ...options.environment, MCP_SETUP_LIST: contents } })
    expect(result.clients.find(client => client.id === 'codex')).toMatchObject({ detected: true, state, canSetup: false })
  })

  // MCP setup supports POSIX hosts; Windows maps a file-as-parent lookup to a different errno.
  it.skipIf(process.platform === 'win32').each(['list', 'setup-all'] as const)('keeps %s independent when one installed client has an unusable configuration directory', async (operation) => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    await mkdir(join(root, 'Applications', 'WorkBuddy.app'))
    const blocked = join(root, 'home', '.cursor')
    await writeFile(blocked, 'existing client data\n')
    if (operation === 'list') {
      const result = await listMcpClients(options)
      expect(result.clients.find(client => client.id === 'cursor')).toMatchObject({ state: 'failed', detected: true, canSetup: false })
      expect(result.clients.find(client => client.id === 'workbuddy')).toMatchObject({ state: 'not-configured', detected: true, canSetup: true })
    } else {
      const result = await setupAllMcpClients(options)
      expect(result.find(item => item.client.id === 'cursor')).toMatchObject({ outcome: 'failed', client: { state: 'failed', detected: true } })
      expect(result.find(item => item.client.id === 'workbuddy')?.outcome).toBe('configured')
      expect(JSON.parse(await readFile(join(root, 'home', '.workbuddy', 'mcp.json'), 'utf8'))).toMatchObject({
        mcpServers: { agentharness: { command: options.nodePath } },
      })
    }
    expect(await readFile(blocked, 'utf8')).toBe('existing client data\n')
  })

  it('preserves a directory occupying one client config while configuring another client independently', async () => {
    const { root, options } = await fixture()
    const cursorPath = join(root, 'home', '.cursor', 'mcp.json')
    const retained = join(cursorPath, 'user-data.txt')
    await mkdir(cursorPath, { recursive: true })
    await writeFile(retained, 'unrelated client data')
    const buddyPath = join(root, 'home', '.workbuddy', 'mcp.json')
    await mkdir(join(root, 'home', '.workbuddy'))
    await writeFile(buddyPath, JSON.stringify({ keep: 'local preference', mcpServers: { sibling: { command: 'existing' } } }))
    const listed = await listMcpClients(options)
    expect(listed.clients.find(client => client.id === 'cursor')).toMatchObject({ state: 'failed', canSetup: false })
    expect(listed.clients.find(client => client.id === 'workbuddy')).toMatchObject({ state: 'not-configured', canSetup: true })
    const configured = await setupAllMcpClients(options)
    expect(configured.find(result => result.client.id === 'cursor')).toMatchObject({ outcome: 'failed', client: { state: 'failed' } })
    expect(configured.find(result => result.client.id === 'workbuddy')?.outcome).toBe('configured')
    expect(await readFile(retained, 'utf8')).toBe('unrelated client data')
    expect(JSON.parse(await readFile(buddyPath, 'utf8'))).toMatchObject({ keep: 'local preference', mcpServers: {
      sibling: { command: 'existing' }, agentharness: { command: options.nodePath },
    } })
  })

  it('atomically adds one JSON entry, preserves siblings, and is idempotent', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    const path = join(root, 'home', '.cursor', 'mcp.json')
    await mkdir(join(root, 'home', '.cursor'))
    await writeFile(path, `${JSON.stringify({ keep: true, mcpServers: { sibling: { command: 'sibling' } } })}\n`)

    const first = await setupMcpClient(options, { clientId: 'cursor', displayName: 'Test / Cursor' })
    const second = await setupMcpClient(options, { clientId: 'cursor', displayName: 'Test / Cursor' })
    const document: unknown = JSON.parse(await readFile(path, 'utf8'))

    expect(first.outcome).toBe('configured')
    expect(second.outcome).toBe('already-configured')
    expect(document).toMatchObject({
      keep: true,
      mcpServers: {
        sibling: { command: 'sibling' },
        'agentharness': { command: '/opt/agentharness/runtime/node' },
      },
    })
  })

  it('reports a different registered participant as a conflict without rewriting client settings', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    expect((await setupMcpClient(options, { clientId: 'cursor' })).outcome).toBe('configured')
    const path = join(root, 'home', '.cursor', 'mcp.json')
    const configured = await listMcpClients(options)
    const participant = configured.clients.find(client => client.id === 'cursor')?.participantId
    if (participant === undefined) throw new Error('Missing Cursor client definition')
    const legacy = (await readFile(path, 'utf8')).replace(participant, 'agentharness-test-user-cursor')
    await writeFile(path, legacy)
    expect((await listMcpClients(options)).clients.find(client => client.id === 'cursor')?.state).toBe('conflict')
    expect((await setupMcpClient(options, { clientId: 'cursor' })).outcome).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(legacy)
  })

  it('preserves a persisted HTTP transport conflicting with the generated stdio launcher', async () => {
    const { root, options } = await fixture()
    const directory = join(root, 'home', '.workbuddy')
    const path = join(directory, 'mcp.json')
    await mkdir(directory)
    await writeFile(path, JSON.stringify({ keep: 'local preference', mcpServers: { sibling: { command: 'existing' } } }))
    expect((await setupMcpClient(options, { clientId: 'workbuddy' })).outcome).toBe('configured')
    const original = await readFile(path, 'utf8')
    const changed = original.replace('"type": "stdio"', '"type": "http"')
    expect(changed).not.toBe(original)
    await writeFile(path, changed)
    expect((await listMcpClients(options)).clients.find(client => client.id === 'workbuddy')).toMatchObject({
      state: 'conflict', canSetup: false, restartRequired: false,
    })
    expect(await setupMcpClient(options, { clientId: 'workbuddy' })).toMatchObject({ outcome: 'conflict' })
    expect(await readFile(path, 'utf8')).toBe(changed)
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['non-object root', 'null'],
    ['non-object servers', JSON.stringify({ mcpServers: [] })],
    ['same-name conflict', JSON.stringify({ mcpServers: { 'agentharness': { command: 'other', args: [] } } })],
  ])('leaves %s unchanged', async (_label, contents) => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    const directory = join(root, 'home', '.cursor')
    const path = join(directory, 'mcp.json')
    await mkdir(directory)
    await writeFile(path, contents)

    const result = await setupMcpClient(options, { clientId: 'cursor' })
    expect(result.outcome).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(contents)
  })

  it('refuses to replace a symlinked client configuration', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    const directory = join(root, 'home', '.cursor')
    const target = join(root, 'target.json')
    await mkdir(directory)
    await writeFile(target, '{}\n')
    await symlink(target, join(directory, 'mcp.json'))

    const result = await setupMcpClient(options, { clientId: 'cursor' })
    expect(result.outcome).toBe('failed')
    expect(result.client.detail).toContain('symbolic-link')
    expect(await readFile(target, 'utf8')).toBe('{}\n')
  })

  it.each([
    ['malformed JSON', 'PRIVATE_INVALID_JSON', 'Configuration is not strict JSON.'],
    ['non-object root', '[]', 'configuration root is not a JSON object'],
    ['non-object servers', '{"mcpServers":null}', 'mcpServers is not a JSON object'],
    ['conflicting registration', '{"mcpServers":{"agentharness":{"command":"other","args":[]}}}',
      'a different agentharness entry already exists'],
    ['compatible registration', undefined, undefined],
  ])('rechecks %s committed after inspection before changing client configuration', async (_label, replacement, detail) => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    expect((await setupMcpClient(options, { clientId: 'cursor' })).outcome).toBe('configured')
    const path = join(root, 'home', '.cursor', 'mcp.json')
    const compatible = '\n' + await readFile(path, 'utf8')
    await rm(path)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    writer.beforeLock = async (target) => {
      if (target !== path) return
      entered.resolve(undefined)
      await release.promise
    }
    const pending = setupMcpClient(options, { clientId: 'cursor' })
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Registration settled before acquiring its writer lock') })])
      const contents = replacement ?? compatible
      await writeFile(path, contents)
      release.resolve(undefined)
      const result = await pending
      expect(result).toMatchObject(detail === undefined ? { outcome: 'configured', client: { state: 'configured' } }
        : { outcome: 'failed', client: { state: 'failed', canSetup: false, detail } })
      expect(JSON.stringify(result)).not.toContain('PRIVATE_INVALID_JSON')
      expect(await readFile(path, 'utf8')).toBe(contents)
      await expect(readFile(path + '.lock')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release.resolve(undefined); await pending }
  })

  it('uses an existing secondary client configuration without creating an earlier alias', async () => {
    const { root, options } = await fixture()
    const path = join(root, 'home', '.codebuddy.json')
    await writeFile(path, '{"mcpServers":{"existing":{"command":"local"}}}')
    const result = await setupMcpClient(options, { clientId: 'codebuddy' })
    expect(result).toMatchObject({ outcome: 'configured', client: { configPath: path } })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ mcpServers: {
      existing: { command: 'local' }, agentharness: { type: 'stdio', command: options.nodePath },
    } })
    await expect(readFile(join(root, 'home', '.codebuddy', '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports invalid configuration without copying its contents into diagnostics', async () => {
    const { root, options } = await fixture()
    const directory = join(root, 'home', '.cursor')
    await mkdir(directory)
    await writeFile(join(directory, 'mcp.json'), 'SECRET42')
    const result = await setupMcpClient(options, { clientId: 'cursor' })
    expect(result.outcome).toBe('conflict')
    expect(result.client.detail).not.toContain('SECRET42')
    expect(await readFile(join(directory, 'mcp.json'), 'utf8')).toBe('SECRET42')
  })

  // Official client executables require native POSIX shebang execution; Windows setup is unsupported.
  it.skipIf(process.platform === 'win32').each(['inspection', 'registration'] as const)('reports CLI %s failure without copying command output', async (operation) => {
    const { root, options } = await fixture()
    await fakeExecutable(join(root, 'bin', 'codex'), '#!/bin/sh\nif [ "$2" = list ] && [ "$MCP_SETUP_FAILURE" = registration ]; then printf "[]"; exit 0; fi\nprintf "%s" "$MCP_SETUP_DIAGNOSTIC" >&2\nexit 9\n')
    const result = await setupMcpClient({ ...options, environment: {
      ...options.environment, MCP_SETUP_DIAGNOSTIC: 'SECRET42', MCP_SETUP_FAILURE: operation,
    } }, { clientId: 'codex' })
    expect(result.outcome).toBe('failed')
    expect(result.client.detail).not.toContain('SECRET42')
  })

  // The isolated CLI uses POSIX shebang execution; its exit status alone does not verify registration.
  it.skipIf(process.platform === 'win32').each(['unchanged', 'invalid-list'] as const)(
    'does not report a successful CLI command as configured when verification is %s', async (verification) => {
      const { root, options } = await fixture()
      const directory = join(root, 'home', '.codex')
      await mkdir(directory)
      const configPath = join(directory, 'config.toml')
      const original = '[mcp_servers.sibling]\ncommand = "existing-server"\n'
      await writeFile(configPath, original)
      const attempt = join(root, 'registration-attempt')
      await fakeExecutable(join(root, 'bin', 'codex'), '#!/bin/sh\nif [ "$2" = list ]; then\n  if [ -f "$MCP_SETUP_ATTEMPT" ]; then printf "%s" "$MCP_SETUP_AFTER"; else printf "[]"; fi\nelse printf "%s" "$*" > "$MCP_SETUP_ATTEMPT"; fi\n')
      const result = await setupMcpClient({ ...options, environment: { ...options.environment,
        MCP_SETUP_ATTEMPT: attempt, MCP_SETUP_AFTER: verification === 'unchanged' ? '[]' : '{}',
      } }, { clientId: 'codex' })
      expect(result).toMatchObject({ outcome: 'failed', client: {
        state: verification === 'unchanged' ? 'not-configured' : 'failed', restartRequired: false,
        detail: verification === 'unchanged' ? 'Registration completed but verification did not pass.' : 'Codex returned an invalid MCP list.',
      } })
      expect(await readFile(configPath, 'utf8')).toBe(original)
      expect(await readFile(attempt, 'utf8')).toContain('mcp add agentharness --env DSH_HOME=')
    },
  )

  // These fake CLI executables require native POSIX shebang execution; Windows setup is unsupported.
  it.skipIf(process.platform === 'win32')('uses official CLI arguments and continues when another client fails', async () => {
    const { root, options } = await fixture()
    const codexIdentity = (await listMcpClients(options)).clients.find(client => client.id === 'codex')
    if (codexIdentity === undefined) throw new Error('Missing Codex client definition')
    const codexLog = join(root, 'codex.log')
    const codex = join(root, 'bin', 'codex')
    const transport = {
      type: 'stdio', command: options.nodePath,
      args: [options.dshPath, '--profile', 'mcp', '--connection', options.descriptorPath,
        '--participant-id', codexIdentity.participantId, '--display-name', 'Test User / Codex'],
      env: { DSH_HOME: options.harnessHome },
    }
    await fakeExecutable(codex, `#!/bin/sh\nif [ "$1" = mcp ] && [ "$2" = list ]; then\n  if [ -f "${codexLog}" ]; then printf '%s' '${JSON.stringify([{ name: 'agentharness', transport }])}'; else printf '[]'; fi\n  exit 0\nfi\nprintf '%s\\n%s\\n' "$CODEX_HOME" "$*" > "${codexLog}"\n`)
    const claude = join(root, 'bin', 'claude')
    await fakeExecutable(claude, '#!/bin/sh\nexit 9\n')

    const results = await setupAllMcpClients(options)
    expect(results.find(result => result.client.id === 'codex')?.outcome).toBe('configured')
    const codexLines = (await readFile(codexLog, 'utf8')).trim().split('\n')
    expect(codexLines[0]).toBe(join(root, 'home', '.codex'))
    expect(codexLines[1]).toContain(`mcp add agentharness --env DSH_HOME=${options.harnessHome} -- /opt/agentharness/runtime/node`)
    expect(codexLines[1]).toContain(`/opt/agentharness/lib/bin.js --profile mcp --connection ${options.descriptorPath}`)
    expect(results.find(result => result.client.id === 'claude-code')?.outcome).toBe('failed')
    expect(results).toHaveLength(7)
  })

  // Official Codex list output includes the user's independent server-enabled policy.
  it.skipIf(process.platform === 'win32')('reports a disabled matching Codex launcher without enabling it or changing sibling settings', async () => {
    const { root, options } = await fixture()
    const identity = (await listMcpClients(options)).clients.find(client => client.id === 'codex')
    if (identity === undefined) throw new Error('Missing Codex client definition')
    const transport = { type: 'stdio', command: options.nodePath,
      args: [options.dshPath, '--profile', 'mcp', '--connection', options.descriptorPath,
        '--participant-id', identity.participantId, '--display-name', identity.displayName],
      env: { DSH_HOME: options.harnessHome } }
    const directory = join(root, 'home', '.codex')
    await mkdir(directory)
    const path = join(directory, 'config.toml')
    const original = `[mcp_servers.sibling]\ncommand = "existing-server"\n\n[mcp_servers.agentharness]\nenabled = false\ncommand = ${JSON.stringify(transport.command)}\nargs = ${JSON.stringify(transport.args)}\n\n[mcp_servers.agentharness.env]\nDSH_HOME = ${JSON.stringify(options.harnessHome)}\n`
    await writeFile(path, original)
    const mutationLog = join(root, 'unexpected-registration.log')
    await fakeExecutable(join(root, 'bin', 'codex'), '#!/bin/sh\nif [ "$1" = mcp ] && [ "$2" = list ]; then printf "%s" "$MCP_SETUP_LIST"; exit 0; fi\nprintf "%s" "$*" > "$MCP_SETUP_MUTATION_LOG"\nexit 9\n')
    const deployment = { ...options, environment: { ...options.environment, MCP_SETUP_MUTATION_LOG: mutationLog,
      MCP_SETUP_LIST: JSON.stringify([{ name: 'sibling', enabled: true, transport: { type: 'stdio', command: 'existing-server', args: [] } },
        { name: 'agentharness', enabled: false, transport }]) } }
    const listed = (await listMcpClients(deployment)).clients.find(client => client.id === 'codex')
    expect(listed).toMatchObject({ detected: true, state: 'manual', canSetup: false, restartRequired: false })
    expect(listed?.detail).toContain('disabled')
    expect(await setupMcpClient(deployment, { clientId: 'codex' })).toMatchObject({
      outcome: 'manual', client: { state: 'manual', canSetup: false, restartRequired: false },
    })
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(readFile(mutationLog)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains source Node arguments and detects a different Harness home as a conflict', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    const source = {
      ...options, nodeArgs: ['--import', 'file:///opt/tsx/esm.mjs'],
      dshPath: '/opt/source/apps/cli/src/bin.ts', sourceTsconfigPath: '/opt/source/tsconfig.base.json',
    }
    const first = await setupMcpClient(source, { clientId: 'cursor' })
    expect(first.client.participantId.endsWith('-cursor')).toBe(true)
    expect(first.client.displayName).toBe('Test User / Cursor')
    const path = join(root, 'home', '.cursor', 'mcp.json')
    const before = await readFile(path, 'utf8')
    expect(JSON.parse(before)).toMatchObject({ mcpServers: { agentharness: {
      args: ['--import', 'file:///opt/tsx/esm.mjs', source.dshPath, '--profile', 'mcp', '--connection',
        options.descriptorPath, '--participant-id', first.client.participantId, '--display-name', 'Test User / Cursor'],
      env: { DSH_HOME: options.harnessHome, TSX_TSCONFIG_PATH: '/opt/source/tsconfig.base.json' },
    } } })
    const conflict = await setupMcpClient({ ...source, harnessHome: join(root, 'different-home') }, { clientId: 'cursor' })
    expect(conflict.outcome).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it.each([['--import', 'tsx/esm'], ['--import=tsx/esm']])('resolves source hook arguments %j at the explicit workspace', async (...nodeArgs) => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    const sourceTsconfigPath = resolve(import.meta.dirname, '../../../../tsconfig.base.json')
    const result = await setupMcpClient({ ...options, nodeArgs, sourceTsconfigPath }, { clientId: 'cursor' })
    expect(result.outcome).toBe('configured')
    const document: unknown = JSON.parse(await readFile(join(root, 'home', '.cursor', 'mcp.json'), 'utf8'))
    expect(document).toMatchObject({ mcpServers: { agentharness: {
      args: nodeArgs.length === 1 ? [`--import=${import.meta.resolve('tsx/esm')}`, options.dshPath,
        '--profile', 'mcp', '--connection', options.descriptorPath, '--participant-id',
        result.client.participantId, '--display-name', 'Test User / Cursor'] : ['--import',
        import.meta.resolve('tsx/esm'), options.dshPath, '--profile', 'mcp', '--connection',
        options.descriptorPath, '--participant-id', result.client.participantId, '--display-name', 'Test User / Cursor'],
      env: { DSH_HOME: options.harnessHome, TSX_TSCONFIG_PATH: sourceTsconfigPath },
    } } })
    await expect(setupMcpClient({ ...options, nodeArgs }, { clientId: 'cursor' }))
      .rejects.toThrow('sourceTsconfigPath is required')
  })

  it('reports Windows as unsupported without writing client configuration', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    const result = await setupMcpClient({ ...options, platform: 'win32' }, { clientId: 'cursor' })
    expect(result).toMatchObject({ outcome: 'unsupported', client: { state: 'unsupported', canSetup: false } })
    await expect(readFile(join(root, 'home', '.cursor', 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the Windows setup service loadable without the unsupported descriptor publisher', async () => {
    const { options } = await fixture()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('platform descriptor missing')
    const ctx = new Context()
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const deployment = { ...options, platform: 'win32' as const }
      const service = new McpClientSetupService(ctx, deployment)
      expect(ctx.get('mcpClientSetup') !== undefined).toBe(true)
      expect((await service.list()).clients.every(client => client.state === 'unsupported' && !client.canSetup)).toBe(true)
      expect(await service.setup({ clientId: 'cursor' })).toMatchObject({ outcome: 'unsupported' })
      await expect(readFile(options.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      Object.defineProperty(process, 'platform', platform)
      await ctx.fiber.dispose()
    }
  })

  it('reports an existing CLI configuration as manual when its official command is unavailable', async () => {
    const { root, options } = await fixture()
    await writeFile(join(root, 'home', '.claude.json'), '{}\n')

    const snapshot = await listMcpClients(options)
    const claude = snapshot.clients.find(client => client.id === 'claude-code')
    expect(claude).toMatchObject({
      detected: true,
      state: 'manual',
      canSetup: false,
    })
    expect(claude?.detail).toContain('not available on PATH')
  })
})
