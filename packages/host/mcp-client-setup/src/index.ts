/** Safe local AI-client detection and AgentHarness MCP registration. */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  McpClientId,
  McpClientSetupRequest,
  McpClientSetupResult,
  McpClientSetupSnapshot,
  McpClientSnapshot,
} from './types.ts'

export type * from './types.ts'

const runFile = promisify(execFile)
const SERVER_NAME = 'agentharness'
const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const COMMAND_TIMEOUT_MS = 10_000

/** Runtime facts shared by the installed command and Host Remote service. */
export interface McpClientSetupOptions {
  readonly home?: string
  readonly path?: string
  /** Environment forwarded unchanged to supported client CLIs. */
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly username?: string
  readonly nodePath: string
  readonly mcpPath: string
  readonly url: string
  readonly applicationRoots?: readonly string[]
  readonly executableOverrides?: Partial<Record<McpClientId, string>>
}

/** Cordis deployment facts for the browser-facing setup service. */
export interface Config {
  /** Absolute Node.js executable used by generated STDIO entries. */
  readonly nodePath: string
  /** Absolute packaged AgentHarness MCP bridge entry point. */
  readonly mcpPath: string
  /** Loopback AgentHarness HTTP base URL. */
  readonly url: string
}

interface ResolvedOptions {
  readonly home: string
  readonly path: string
  readonly environment: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly username: string
  readonly nodePath: string
  readonly mcpPath: string
  readonly url: string
  readonly applicationRoots: readonly string[]
  readonly executableOverrides: Partial<Record<McpClientId, string>>
}

interface ClientDefinition {
  readonly id: McpClientId
  readonly label: string
  readonly mechanism: McpClientSnapshot['mechanism']
  readonly executable?: string
  readonly executableCandidates?: readonly string[]
  readonly applications: readonly string[]
  readonly configPaths?: readonly string[]
  readonly addArguments?: (entry: McpEntry) => readonly string[]
  readonly manualDetail?: string
  readonly includeType?: boolean
}

interface McpEntry {
  readonly command: string
  readonly args: readonly string[]
  readonly type?: 'stdio'
}

interface InspectedClient {
  readonly definition: ClientDefinition
  readonly executable: string | undefined
  readonly configPath: string | undefined
  readonly entry: McpEntry
  readonly snapshot: McpClientSnapshot
}

const CLIENTS: readonly ClientDefinition[] = [
  {
    id: 'cursor', label: 'Cursor', mechanism: 'json', executable: 'cursor',
    applications: ['Cursor.app'], configPaths: ['.cursor/mcp.json'],
  },
  {
    id: 'codex', label: 'Codex', mechanism: 'cli', executable: 'codex',
    executableCandidates: ['ChatGPT.app/Contents/Resources/codex'], applications: ['ChatGPT.app'],
    addArguments: entry => ['mcp', 'add', SERVER_NAME, '--', entry.command, ...entry.args],
  },
  {
    id: 'claude-code', label: 'Claude Code', mechanism: 'cli', executable: 'claude',
    applications: [], configPaths: ['.claude.json'],
    addArguments: entry => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', entry.command, ...entry.args],
  },
  {
    id: 'workbuddy', label: 'WorkBuddy', mechanism: 'json', executable: 'workbuddy',
    applications: ['WorkBuddy.app'], configPaths: ['.workbuddy/mcp.json'], includeType: true,
  },
  {
    id: 'codebuddy', label: 'CodeBuddy', mechanism: 'json', executable: 'codebuddy',
    applications: ['CodeBuddy.app'],
    configPaths: ['.codebuddy/.mcp.json', '.codebuddy/mcp.json', '.codebuddy.json'], includeType: true,
  },
  {
    id: 'trae', label: 'TRAE', mechanism: 'manual', executable: 'trae',
    applications: ['TRAE.app'],
    manualDetail: 'Open TRAE MCP settings and add the AgentHarness bridge with the printed manual configuration.',
  },
  {
    id: 'doubao', label: 'Doubao', mechanism: 'manual', executable: 'doubao',
    applications: ['Doubao.app'],
    manualDetail: 'No stable public unattended local MCP registration mechanism is available; private app data was not modified.',
  },
]

function resolveOptions(options: McpClientSetupOptions): ResolvedOptions {
  if (!isAbsolute(options.nodePath) || !isAbsolute(options.mcpPath)) {
    throw new TypeError('mcp-client-setup: nodePath and mcpPath must be absolute')
  }
  const url = new URL(options.url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new TypeError('mcp-client-setup: url must use HTTP(S) on loopback')
  }
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const applicationRoots = options.applicationRoots ?? (platform === 'darwin'
    ? ['/Applications', join(home, 'Applications')]
    : [])
  return {
    home,
    platform,
    path: options.path ?? process.env.PATH ?? '',
    environment: options.environment ?? process.env,
    username: options.username ?? userInfo().username,
    nodePath: options.nodePath,
    mcpPath: options.mcpPath,
    url: url.href.replace(/\/$/u, ''),
    applicationRoots,
    executableOverrides: options.executableOverrides ?? {},
  }
}

function identity(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  const prefixed = /^[a-z]/u.test(normalized) ? normalized : `agent-${normalized || 'local'}`
  return prefixed.slice(0, 80)
}

function entryFor(definition: ClientDefinition, options: ResolvedOptions, displayName?: string): McpEntry {
  const participantId = identity(`agentharness-${options.username}-${definition.id}`)
  return {
    ...definition.includeType === true ? { type: 'stdio' as const } : {},
    command: options.nodePath,
    args: [
      options.mcpPath,
      '--url', options.url,
      '--participant-id', participantId,
      '--display-name', displayName?.trim() || `${options.username} / ${definition.label}`,
    ],
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function executable(definition: ClientDefinition, options: ResolvedOptions): Promise<string | undefined> {
  const override = options.executableOverrides[definition.id]
  if (override !== undefined) return override
  const names = definition.executable === undefined ? [] : [definition.executable]
  for (const directory of options.path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error
      }
    }
  }
  for (const root of options.applicationRoots) {
    for (const candidate of definition.executableCandidates ?? []) {
      const path = join(root, candidate)
      try {
        await access(path, constants.X_OK)
        return path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error
      }
    }
  }
  return undefined
}

async function detected(definition: ClientDefinition, options: ResolvedOptions, command?: string): Promise<boolean> {
  if (command !== undefined) return true
  for (const root of options.applicationRoots) {
    for (const application of definition.applications) {
      if (await exists(join(root, application))) return true
    }
  }
  for (const path of definition.configPaths ?? []) {
    if (await exists(join(options.home, path))) return true
  }
  return false
}

async function configPath(definition: ClientDefinition, options: ResolvedOptions): Promise<string | undefined> {
  if (definition.configPaths === undefined) return undefined
  for (const path of definition.configPaths) {
    const absolute = join(options.home, path)
    if (await exists(absolute)) return absolute
  }
  return join(options.home, definition.configPaths[0] as string)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compatibleEntry(value: unknown, expected: McpEntry): boolean {
  if (!isRecord(value) || value.command !== expected.command || !Array.isArray(value.args)) return false
  if (value.type !== undefined && value.type !== 'stdio') return false
  return value.args.length === expected.args.length && value.args.every((argument, index) => argument === expected.args[index])
}

async function inspectJson(path: string, expected: McpEntry): Promise<{ state: McpClientSnapshot['state']; detail?: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'not-configured' }
    return { state: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    const document: unknown = JSON.parse(raw)
    if (!isRecord(document)) return { state: 'conflict', detail: 'Configuration root is not a JSON object.' }
    if (document.mcpServers === undefined) return { state: 'not-configured' }
    if (!isRecord(document.mcpServers)) return { state: 'conflict', detail: 'mcpServers is not a JSON object.' }
    const current = document.mcpServers[SERVER_NAME]
    if (current === undefined) return { state: 'not-configured' }
    return compatibleEntry(current, expected)
      ? { state: 'configured' }
      : { state: 'conflict', detail: `A different ${SERVER_NAME} entry already exists.` }
  } catch (error) {
    return { state: 'conflict', detail: `Configuration is not strict JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function inspectCodex(
  command: string,
  expected: McpEntry,
  environment: NodeJS.ProcessEnv,
): Promise<{ state: McpClientSnapshot['state']; detail?: string }> {
  try {
    const { stdout } = await runFile(command, ['mcp', 'list', '--json'], {
      encoding: 'utf8',
      env: environment,
      timeout: COMMAND_TIMEOUT_MS,
    })
    const list: unknown = JSON.parse(stdout)
    if (!Array.isArray(list)) return { state: 'failed', detail: 'Codex returned an invalid MCP list.' }
    const current: unknown = (list as unknown[]).find((item: unknown) => isRecord(item) && item.name === SERVER_NAME)
    if (!isRecord(current)) return { state: 'not-configured' }
    const transport = current.transport
    return isRecord(transport) && compatibleEntry(transport, expected)
      ? { state: 'configured' }
      : { state: 'conflict', detail: `A different ${SERVER_NAME} entry already exists.` }
  } catch (error) {
    return { state: 'failed', detail: `Could not inspect Codex MCP settings: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function inspectClient(
  definition: ClientDefinition,
  options: ResolvedOptions,
  requestedDisplayName?: string,
): Promise<InspectedClient> {
  const command = await executable(definition, options)
  const isDetected = await detected(definition, options, command)
  const path = await configPath(definition, options)
  const entry = entryFor(definition, options, requestedDisplayName)
  const participantId = entry.args[4] as string
  const displayName = entry.args[6] as string
  let observation: { state: McpClientSnapshot['state']; detail?: string }
  if (!isDetected) observation = { state: 'not-installed' }
  else if (definition.mechanism === 'manual') observation = {
    state: 'manual',
    ...(definition.manualDetail === undefined ? {} : { detail: definition.manualDetail }),
  }
  else if (definition.mechanism === 'cli' && command === undefined) observation = {
    state: 'manual',
    detail: 'The supported registration command is not available on PATH.',
  }
  else if (definition.id === 'codex' && command !== undefined) {
    observation = await inspectCodex(command, entry, options.environment)
  }
  else if (path !== undefined) observation = await inspectJson(path, entry)
  else observation = { state: 'manual', detail: 'No supported registration mechanism is available.' }
  return {
    definition,
    executable: command,
    configPath: path,
    entry,
    snapshot: {
      id: definition.id,
      label: definition.label,
      detected: isDetected,
      mechanism: definition.mechanism,
      state: observation.state,
      canSetup: isDetected && observation.state === 'not-configured' && definition.mechanism !== 'manual'
        && (definition.mechanism !== 'cli' || command !== undefined),
      participantId,
      displayName,
      restartRequired: observation.state === 'configured',
      ...(path === undefined ? {} : { configPath: path }),
      ...(observation.detail === undefined ? {} : { detail: observation.detail }),
    },
  }
}

/**
 * Read every supported client's current safe setup state.
 * @param options - runtime, filesystem, environment, and executable lookup inputs.
 * @returns detected clients and their independently verified setup states.
 */
export async function listMcpClients(options: McpClientSetupOptions): Promise<McpClientSetupSnapshot> {
  const resolved = resolveOptions(options)
  const clients = await Promise.all(CLIENTS.map(client => inspectClient(client, resolved)))
  return { clients: clients.map(client => client.snapshot) }
}

async function configureJson(client: InspectedClient): Promise<void> {
  const path = client.configPath
  if (path === undefined) throw new Error('client has no JSON configuration path')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    let document: Record<string, unknown> = {}
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('refusing to replace a symbolic-link configuration')
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!isRecord(parsed)) throw new Error('configuration root is not a JSON object')
      document = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const currentServers = document.mcpServers
    if (currentServers !== undefined && !isRecord(currentServers)) throw new Error('mcpServers is not a JSON object')
    const servers = { ...(currentServers ?? {}) } as Record<string, unknown>
    const current = servers[SERVER_NAME]
    if (current !== undefined) {
      if (compatibleEntry(current, client.entry)) return
      throw new Error(`a different ${SERVER_NAME} entry already exists`)
    }
    servers[SERVER_NAME] = client.entry
    await writeFileAtomic(path, `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  })
}

async function configureCli(client: InspectedClient, environment: NodeJS.ProcessEnv): Promise<void> {
  if (client.executable === undefined || client.definition.addArguments === undefined) {
    throw new Error('supported registration command is unavailable')
  }
  await runFile(client.executable, [...client.definition.addArguments(client.entry)], {
    encoding: 'utf8',
    env: environment,
    timeout: COMMAND_TIMEOUT_MS,
  })
}

/**
 * Configure one client without overwriting a different same-name entry.
 * @param options - runtime, filesystem, environment, and executable lookup inputs.
 * @param request - selected client and optional display-name override.
 * @returns independently verified configuration outcome.
 */
export async function setupMcpClient(
  options: McpClientSetupOptions,
  request: McpClientSetupRequest,
): Promise<McpClientSetupResult> {
  if (!CLIENT_ID_PATTERN.test(request.clientId)) throw new TypeError('mcp-client-setup: invalid client id')
  const definition = CLIENTS.find(client => client.id === request.clientId)
  if (definition === undefined) throw new TypeError(`mcp-client-setup: unsupported client ${request.clientId}`)
  const resolved = resolveOptions(options)
  const before = await inspectClient(definition, resolved, request.displayName)
  if (before.snapshot.state === 'configured') return { outcome: 'already-configured', client: before.snapshot }
  if (before.snapshot.state === 'not-installed') return { outcome: 'not-installed', client: before.snapshot }
  if (before.snapshot.state === 'manual') return { outcome: 'manual', client: before.snapshot }
  if (before.snapshot.state === 'conflict') return { outcome: 'conflict', client: before.snapshot }
  if (!before.snapshot.canSetup) return { outcome: 'failed', client: before.snapshot }
  try {
    if (definition.mechanism === 'json') await configureJson(before)
    else await configureCli(before, resolved.environment)
    const after = await inspectClient(definition, resolved, request.displayName)
    if (after.snapshot.state !== 'configured') {
      return { outcome: 'failed', client: { ...after.snapshot, detail: after.snapshot.detail ?? 'Registration completed but verification did not pass.' } }
    }
    return { outcome: 'configured', client: after.snapshot }
  } catch (error) {
    return {
      outcome: 'failed',
      client: {
        ...before.snapshot,
        state: 'failed',
        canSetup: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Configure every recognized client independently and retain one result per client.
 * @param options - runtime, filesystem, environment, and executable lookup inputs.
 * @returns one setup result for every recognized client.
 */
export async function setupAllMcpClients(options: McpClientSetupOptions): Promise<readonly McpClientSetupResult[]> {
  const results: McpClientSetupResult[] = []
  for (const client of CLIENTS) results.push(await setupMcpClient(options, { clientId: client.id }))
  return results
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Trusted local AI-client MCP setup service. */
    mcpClientSetup: McpClientSetupService
  }
}

/** Trusted Host Remote for detection and explicit browser-initiated setup. */
export class McpClientSetupService extends TypertRemoteService {
  static Config: s<Config> = s.object({
    nodePath: s.string().required(),
    mcpPath: s.string().required(),
    url: s.string().required(),
  })

  private readonly options: McpClientSetupOptions

  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpClientSetup')
    resolveOptions(config)
    this.options = config
  }

  /**
   * Return the current configuration state of every recognized client.
   *
   * @returns One point-in-time client detection and configuration snapshot.
   */
  @Remote('list')
  list(): Promise<McpClientSetupSnapshot> {
    return listMcpClients(this.options)
  }

  /**
   * Configure exactly one supported client after conflict-safe inspection.
   *
   * @param request - Client id and optional display-name override.
   * @returns The exact setup outcome plus the refreshed client state.
   */
  @Remote('setup')
  setup(request: McpClientSetupRequest): Promise<McpClientSetupResult> {
    return setupMcpClient(this.options, request)
  }
}

export default McpClientSetupService
