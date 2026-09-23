import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listMcpClients, setupAllMcpClients, setupMcpClient, type McpClientSetupOptions } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; options: McpClientSetupOptions }> {
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'agentharness-mcp-setup-'))
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
        ...process.env,
        CODEX_HOME: join(home, '.codex'),
        HOME: home,
        PATH: bin,
      },
      platform: 'darwin',
      username: 'Test User',
      nodePath: '/opt/agentharness/runtime/node',
      mcpPath: '/opt/agentharness/mcp.mjs',
      url: 'http://127.0.0.1:3080',
      applicationRoots: [apps],
    },
  }
}

async function fakeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

describe('MCP client setup', () => {
  it('detects clients independently and leaves unsupported clients manual-only', async () => {
    const { root, options } = await fixture()
    await mkdir(join(root, 'Applications', 'Cursor.app'))
    await mkdir(join(root, 'Applications', 'Doubao.app'))
    const snapshot = await listMcpClients(options)

    expect(snapshot.clients.find(client => client.id === 'cursor')).toMatchObject({ detected: true, state: 'not-configured', canSetup: true })
    expect(snapshot.clients.find(client => client.id === 'doubao')).toMatchObject({ detected: true, state: 'manual', canSetup: false })
    expect(snapshot.clients.find(client => client.id === 'claude-code')).toMatchObject({ detected: false, state: 'not-installed' })
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

  it.each([
    ['malformed JSON', '{broken'],
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

  it('uses official CLI arguments and continues when another client fails', async () => {
    const { root, options } = await fixture()
    const codexLog = join(root, 'codex.log')
    const codex = join(root, 'bin', 'codex')
    await fakeExecutable(codex, `#!/bin/sh\nif [ "$1" = mcp ] && [ "$2" = list ]; then\n  if [ -f "${codexLog}" ]; then printf '[{"name":"agentharness","transport":{"type":"stdio","command":"/opt/agentharness/runtime/node","args":["/opt/agentharness/mcp.mjs","--url","http://127.0.0.1:3080","--participant-id","agentharness-test-user-codex","--display-name","Test User / Codex"]}}]'; else printf '[]'; fi\n  exit 0\nfi\nprintf '%s\\n%s\\n' "$CODEX_HOME" "$*" > "${codexLog}"\n`)
    const claude = join(root, 'bin', 'claude')
    await fakeExecutable(claude, '#!/bin/sh\nexit 9\n')

    const results = await setupAllMcpClients(options)
    expect(results.find(result => result.client.id === 'codex')?.outcome).toBe('configured')
    const codexLines = (await readFile(codexLog, 'utf8')).trim().split('\n')
    expect(codexLines[0]).toBe(join(root, 'home', '.codex'))
    expect(codexLines[1]).toContain('mcp add agentharness -- /opt/agentharness/runtime/node')
    expect(results.find(result => result.client.id === 'claude-code')?.outcome).toBe('failed')
    expect(results).toHaveLength(7)
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
