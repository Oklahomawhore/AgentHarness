/** Real profile authentication, restart adoption, and model-visible MCP failures. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../../../../', import.meta.url))
const sourceArgs = ['--import', import.meta.resolve('tsx/esm'), join(repository, 'apps/cli/src/bin.ts')]
const builtArgs = [join(repository, 'apps/cli/lib/bin.js')]
const deadlineMs = 60_000

function environment(home: string, mode: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  if (mode === 'source') env.TSX_TSCONFIG_PATH = join(repository, 'tsconfig.base.json')
  return env
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  const force = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  try { child.kill('SIGTERM'); await exited } finally { clearTimeout(force) }
}

interface Descriptor { generation: string; launchUrl: string }

async function descriptor(home: string, host: ChildProcessWithoutNullStreams, previous?: string): Promise<Descriptor> {
  const expires = Date.now() + deadlineMs
  while (Date.now() < expires) {
    if (host.exitCode !== null || host.signalCode !== null) throw new Error('Web profile exited before publishing its MCP descriptor')
    let text: string | undefined
    try { text = await readFile(join(home, 'mcp/connection.json'), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text !== undefined) {
      const value = JSON.parse(text) as Descriptor
      if (value.generation !== previous) return value
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Web profile did not publish its MCP descriptor before the deadline')
}

interface ClientEntry { command: string; args: string[]; env: Record<string, string> }

async function bridge(
  args: readonly string[], home: string, mode: string, entry?: ClientEntry,
): Promise<{ client: Client; stderr: () => string }> {
  const client = new Client({ name: 'mcp-profile-acceptance', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: entry?.command ?? process.execPath,
    args: entry?.args ?? [...args, '--profile', 'mcp', '--participant-id', 'profile-acceptance', '--display-name', 'Profile acceptance'],
    cwd: home, env: entry === undefined ? environment(home, mode) : { ...environment(home, 'built'), ...entry.env }, stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  try { await client.connect(transport, { timeout: deadlineMs }) } catch (error) {
    await client.close()
    throw error
  }
  return { client, stderr: () => stderr }
}

for (const [mode, args] of [['source', sourceArgs], ['built', builtArgs]] as const) {
  it.skipIf(process.platform === 'win32')(`${mode}: serves a bounded safe MCP failure without Host credentials`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-unavailable-'))
    let client: Client | undefined
    try {
      const connected = await bridge(args, home, mode)
      client = connected.client
      const catalog = {
        instructions: client.getInstructions(),
        tools: (await client.listTools()).tools.map(({ name, title, description }) => ({ name, title, description })),
        resourceTemplates: (await client.listResourceTemplates()).resourceTemplates
          .map(({ name, title, description, uriTemplate, mimeType }) => ({ name, title, description, uriTemplate, mimeType })),
      }
      await expect(JSON.stringify(catalog, null, 2) + '\n')
        .toMatchFileSnapshot(new URL('./expected/catalog.json', import.meta.url).pathname)
      const result = await client.callTool({ name: 'agentharness_task_list', arguments: {} }, undefined, { timeout: 10_000 })
      await expect(JSON.stringify(result, null, 2) + '\n').toMatchFileSnapshot(new URL('./expected/descriptor-unavailable.json', import.meta.url).pathname)
      expect(connected.stderr()).toBe('')
    } finally {
      await client?.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(`${mode}: exits on EOF while Host authentication is stalled`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-eof-'))
    const server = createServer((_request, _response) => {
      // A connected Host never completes authentication; EOF must abort the pending exchange.
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test Host has no TCP port')
    const directory = join(home, 'mcp')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'connection.json'), JSON.stringify({
      version: 1, generation: 'stalled-host', launchUrl: `http://127.0.0.1:${String(address.port)}/?token=fixture`,
    }), { mode: 0o600 })
    const requested = once(server, 'request', { signal: AbortSignal.timeout(10_000) })
    const child = spawn(process.execPath, [...args, '--profile', 'mcp'], {
      cwd: home, env: environment(home, mode), stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    try {
      const initialized = once(lines, 'line', { signal: AbortSignal.timeout(10_000) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'EOF acceptance', version: '1' },
      } }) + '\n')
      const [frame] = await initialized as [string]
      expect(JSON.parse(frame)).toMatchObject({ id: 1, result: { serverInfo: { name: 'agentharness' } } })
      await requested
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
      child.stdin.end()
      expect(await exited).toEqual([0, null])
      expect(stderr).toBe('')
    } finally {
      lines.close()
      await stop(child)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(`${mode}: authenticates real Host calls and adopts a restarted Host in the same MCP session`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-restart-'))
    const start = (): ChildProcessWithoutNullStreams => {
      const child = spawn(process.execPath, [...args, '--profile', 'web', '--no-open', '--port', '0'], {
        cwd: home, env: environment(home, mode), stdio: ['pipe', 'pipe', 'pipe'],
      })
      // The Web startup URL contains a secret. Drain it without including it in diagnostics.
      child.stdout.resume()
      child.stderr.resume()
      return child
    }
    let host = start()
    let client: Client | undefined
    try {
      const first = await descriptor(home, host)
      const origin = new URL(first.launchUrl).origin
      const unauthenticated = await fetch(`${origin}/api/developmentTasks/list`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000),
      })
      expect(unauthenticated.status).toBe(401)
      await unauthenticated.body?.cancel()
      // Generate an actual client entry through Host setup, then execute it from an unrelated cwd.
      await mkdir(join(home, '.cursor'))
      await writeFile(join(home, '.cursor/mcp.json'), '{"mcpServers":{}}')
      const login = await fetch(first.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      const cookie = login.headers.getSetCookie()[0]?.split(';', 1)[0]
      await login.body?.cancel()
      if (cookie === undefined) throw new Error('Host did not issue a setup authentication cookie')
      const setup = await fetch(`${origin}/api/mcpClientSetup/setup`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ type: 'client-request', rpcId: 'setup-fixture', method: 'mcpClientSetup/setup',
          payload: { args: { request: { clientId: 'cursor' } } } }),
      })
      expect(setup.status).toBe(200)
      expect(await setup.json()).toMatchObject({ result: { ok: true, value: { outcome: 'configured' } } })
      const configuration = JSON.parse(await readFile(join(home, '.cursor/mcp.json'), 'utf8')) as { mcpServers: { agentharness: ClientEntry } }
      const entry = configuration.mcpServers.agentharness
      expect(entry.args).toEqual(expect.arrayContaining(['--profile', 'mcp', '--connection', join(home, 'mcp/connection.json')]))
      expect(entry.env.DSH_HOME).toBe(home)
      expect(entry.env.TSX_TSCONFIG_PATH).toBe(mode === 'source' ? join(repository, 'tsconfig.base.json') : undefined)
      const clientCwd = join(home, 'external-client-cwd')
      await mkdir(clientCwd)
      const connected = await bridge(args, clientCwd, mode, entry)
      client = connected.client
      const created = await client.callTool({ name: 'agentharness_task_create', arguments: {
        objective: 'Survive the local Host restart', scope: 'Authenticated MCP profile acceptance',
      } }, undefined, { timeout: 10_000 })
      expect(created.isError).not.toBe(true)
      const task = (created.structuredContent as Record<string, unknown> | undefined)?.task as { id: string }
      expect(typeof task.id).toBe('string')
      await stop(host)
      host = start()
      const second = await descriptor(home, host, first.generation)
      expect(second.launchUrl === first.launchUrl).toBe(false)
      const tasks = await client.callTool({ name: 'agentharness_task_list', arguments: {} }, undefined, { timeout: 10_000 })
      expect(tasks.isError).not.toBe(true)
      expect((tasks.structuredContent as Record<string, unknown> | undefined)?.items)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id })]))
      expect(connected.stderr()).toBe('')
    } finally {
      await client?.close()
      await stop(host)
      await rm(home, { recursive: true, force: true })
    }
  }, 150_000)
}
