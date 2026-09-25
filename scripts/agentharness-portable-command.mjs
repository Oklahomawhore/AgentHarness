#!/usr/bin/env node
/** Manage an installed AgentHarness runtime and print client-specific MCP setup. */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { joinCluster, readClusterCredential } from './agentharness-cluster.mjs'

const DEFAULT_PORT = 3080
const STARTUP_TIMEOUT_MS = 20_000
const GRACEFUL_STOP_TIMEOUT_MS = 2_000
const FORCED_STOP_TIMEOUT_MS = 3_000

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function commandRoot(environment = process.env) {
  return resolve(environment.AGENTHARNESS_ACTIVE_ROOT ?? import.meta.dirname)
}

function stateRoot(environment) {
  if (environment.AGENTHARNESS_RUNTIME_DIR !== undefined) return resolve(environment.AGENTHARNESS_RUNTIME_DIR)
  const home = environment.HOME ?? homedir()
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'agentharness')
}

function parsePort(args, environment = process.env) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--port') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--port needs a value')
      return validatePort(value)
    }
    if (argument?.startsWith('--port=')) return validatePort(argument.slice('--port='.length))
  }
  return validatePort(environment.AGENTHARNESS_PORT ?? String(DEFAULT_PORT))
}

function hasPortOption(args) {
  return args.some(argument => argument === '--port' || argument.startsWith('--port='))
}

function validatePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port ${JSON.stringify(value)}`)
  return port
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function normalizeOwnedEntry(value) {
  const normalized = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function readProcessCommand(pid) {
  if (process.platform === 'win32') {
    return spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}').CommandLine`,
    ], { encoding: 'utf8', windowsHide: true })
  }
  return spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
}

async function endpointReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  return false
}

async function installedVersion(root) {
  const manifest = await readJson(join(root, 'agentharness-portable.json'))
  if (typeof manifest?.version !== 'string') throw new Error('agentharness-portable.json does not contain a version')
  return manifest.version
}

async function readRuntimeState(environment) {
  return readJson(join(stateRoot(environment), 'server.json'))
}

async function removeRuntimeState(environment) {
  await rm(join(stateRoot(environment), 'server.json'), { force: true })
}

async function stopRuntime(environment, quiet = false) {
  const state = await readRuntimeState(environment)
  if (state === undefined || !Number.isInteger(state.pid) || !processExists(state.pid)) {
    await removeRuntimeState(environment)
    if (!quiet) process.stdout.write('AgentHarness is not running.\n')
    return false
  }
  if (typeof state.entry !== 'string') throw new Error(`runtime state for process ${state.pid} has no owned entry path; refusing to signal it`)
  const processCommand = readProcessCommand(state.pid)
  if (processCommand.error !== undefined || processCommand.status !== 0
    || typeof processCommand.stdout !== 'string'
    || !normalizeOwnedEntry(processCommand.stdout).includes(normalizeOwnedEntry(state.entry))) {
    throw new Error(`process ${state.pid} does not match the recorded AgentHarness entry; refusing to signal it`)
  }
  if (state.pid <= 1) throw new Error(`runtime state contains unsafe process id ${state.pid}`)
  const signal = (name) => {
    try {
      process.kill(process.platform === 'win32' ? state.pid : -state.pid, name)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  signal('SIGTERM')
  let stopped = await waitFor(() => !processExists(state.pid), GRACEFUL_STOP_TIMEOUT_MS)
  if (!stopped) {
    signal('SIGKILL')
    stopped = await waitFor(() => !processExists(state.pid), FORCED_STOP_TIMEOUT_MS)
  }
  if (!stopped) {
    throw new Error(`AgentHarness process ${state.pid} survived SIGTERM and SIGKILL; inspect it before retrying`)
  }
  await removeRuntimeState(environment)
  if (!quiet) process.stdout.write('AgentHarness stopped.\n')
  return true
}

async function openBrowser(url, environment) {
  if (environment.AGENTHARNESS_NO_OPEN === '1') return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : process.platform === 'win32' ? 'cmd.exe' : undefined
  if (command === undefined) return
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', () => {})
  child.unref()
}

/** Read the authenticated Web URL from the installed runtime log and select the AgentHarness first screen. */
export async function collaborationBrowserUrl(logPath, origin) {
  let authenticated
  const found = await waitFor(async () => {
    const log = await readFile(logPath, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return ''
      throw error
    })
    const match = /dsh web: (https?:\/\/[^\s]+)/u.exec(log)
    if (match?.[1] === undefined) return false
    const candidate = new URL(match[1])
    if (candidate.origin !== origin || !candidate.searchParams.get('token')) return false
    authenticated = candidate
    return true
  }, 5_000)
  if (!found || authenticated === undefined) {
    throw new Error('the AgentHarness Web server did not print an authenticated browser URL; inspect the runtime log')
  }
  authenticated.hash = 'agentharness=collaboration'
  return authenticated.href
}

async function startRuntime(args, environment) {
  const root = commandRoot(environment)
  const version = await installedVersion(root)
  const port = parsePort(args, environment)
  const url = `http://127.0.0.1:${port}`
  const runtimeState = await readRuntimeState(environment)
  if (runtimeState !== undefined && Number.isInteger(runtimeState.pid) && processExists(runtimeState.pid)) {
    if (runtimeState.version === version && runtimeState.port === port && await endpointReady(port)) {
      process.stdout.write(`AgentHarness ${version} is already running at ${url}\n`)
      if (environment.AGENTHARNESS_NO_OPEN !== '1') {
        await openBrowser(await collaborationBrowserUrl(runtimeState.logPath, url), environment)
      }
      return
    }
    if (!await endpointReady(runtimeState.port)) {
      throw new Error(`runtime state names live process ${runtimeState.pid}, but its Web endpoint is unavailable; inspect before replacing it`)
    }
    await stopRuntime(environment, true)
  } else {
    await removeRuntimeState(environment)
  }

  if (await endpointReady(port)) {
    throw new Error(`port ${port} already has a responding HTTP service that is not owned by this AgentHarness installation`)
  }

  const directory = stateRoot(environment)
  const logPath = join(directory, 'server.log')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const log = openSync(logPath, 'a', 0o600)
  const logOffset = fstatSync(log).size
  let exitResult
  let child
  try {
    const runtimeArguments = hasPortOption(args) ? ['--no-open', ...args] : ['--no-open', '--port', String(port), ...args]
    child = spawn(process.execPath, [join(root, 'start.mjs'), ...runtimeArguments], {
      cwd: root,
      detached: true,
      env: {
        ...environment,
        AGENTHARNESS_URL: url,
        AGENTHARNESS_MCP_NODE: join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
        AGENTHARNESS_MCP_PATH: join(root, 'mcp.mjs'),
      },
      stdio: ['ignore', log, log],
    })
    if (child.pid === undefined) throw new Error('AgentHarness process did not receive a PID')
    child.once('exit', (code, signal) => { exitResult = signal === null ? `exit code ${code}` : `signal ${signal}` })
    child.once('error', error => { exitResult = error.message })
    child.unref()
  } finally {
    closeSync(log)
  }
  await writeFile(join(directory, 'server.json'), `${JSON.stringify({
    pid: child.pid,
    entry: join(root, 'start.mjs'),
    port,
    url,
    version,
    startedAt: new Date().toISOString(),
    logPath,
    processGroup: process.platform !== 'win32',
  }, null, 2)}\n`, { mode: 0o600 })

  const ready = await waitFor(async () => {
    if (exitResult !== undefined) return true
    return endpointReady(port)
  }, STARTUP_TIMEOUT_MS)
  if (!ready || exitResult !== undefined || !await endpointReady(port)) {
    const reason = exitResult === undefined
      ? `did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s at ${url}`
      : `exited before readiness (${exitResult})`
    if (exitResult === undefined) await stopRuntime(environment, true)
    else await removeRuntimeState(environment)
    const output = (await readFile(logPath)).subarray(logOffset).toString('utf8')
      .replace(/([?&]token=)[^\s&#]+/gu, '$1[redacted]')
      .trim().slice(-8_000)
    throw new Error(`AgentHarness ${reason}; inspect ${logPath}${output === '' ? '' : `\nStartup output:\n${output}`}`)
  }
  process.stdout.write(`AgentHarness ${version} is ready at ${url}\nLogs: ${logPath}\n`)
  if (environment.AGENTHARNESS_NO_OPEN !== '1') {
    await openBrowser(await collaborationBrowserUrl(logPath, url), environment)
  }
}

/** Render copy-ready MCP setup that uses the portable bundled Node runtime. */
export function renderMcpGuide(root = commandRoot(), port = DEFAULT_PORT) {
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const mcp = join(root, 'mcp.mjs')
  const url = `http://127.0.0.1:${port}`
  const cursor = JSON.stringify({
    mcpServers: {
      'agentharness': {
        command: node,
        args: [mcp, '--url', url, '--participant-id', '<your-name>-cursor', '--display-name', '<Your Name> / Cursor'],
      },
    },
  }, null, 2)
  return [
    '',
    'MCP setup (replace <your-name> and <Your Name>):',
    '',
    'Cursor — add to .cursor/mcp.json:',
    cursor,
    '',
    'Codex:',
    `codex mcp add agentharness -- ${shellQuote(node)} ${shellQuote(mcp)} --url ${url} --participant-id <your-name>-codex --display-name '<Your Name> / Codex'`,
    '',
    'Claude Code:',
    `claude mcp add --scope user agentharness -- ${shellQuote(node)} ${shellQuote(mcp)} --url ${url} --participant-id <your-name>-claude --display-name '<Your Name> / Claude'`,
    '',
    'Reload the client, then call agentharness_task_list.',
    '',
  ].join('\n')
}

function mcpSetupOptions(root, port, environment) {
  return {
    ...(environment.HOME === undefined ? {} : { home: environment.HOME }),
    ...(environment.PATH === undefined ? {} : { path: environment.PATH }),
    ...(environment.USER === undefined ? {} : { username: environment.USER }),
    environment,
    nodePath: join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    mcpPath: join(root, 'mcp.mjs'),
    url: `http://127.0.0.1:${port}`,
  }
}

function renderMcpStatus(clients) {
  return clients.map((client) => {
    const detail = client.detail === undefined ? '' : ` — ${client.detail}`
    return `  ${client.label}: ${client.state}${detail}`
  }).join('\n')
}

async function loadMcpSetup() {
  try {
    return await import('@deepseek-ai/dsh-host-mcp-client-setup')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
}

async function configureMcpClients(root, port, environment) {
  const setup = await loadMcpSetup()
  if (setup === undefined) {
    process.stdout.write('\nMCP automatic setup is unavailable in this payload; use the manual guide below.\n')
    process.stdout.write(renderMcpGuide(root, port))
    return
  }
  const results = await setup.setupAllMcpClients(mcpSetupOptions(root, port, environment))
  process.stdout.write('\nMCP automatic setup:\n')
  for (const result of results) {
    const detail = result.client.detail === undefined ? '' : ` — ${result.client.detail}`
    process.stdout.write(`  ${result.client.label}: ${result.outcome}${detail}\n`)
  }
  const configured = results.filter(result => ['configured', 'already-configured'].includes(result.outcome)).length
  process.stdout.write(`Configured or already configured: ${configured}/${results.length}. Restart or reload configured clients to connect.\n`)
  process.stdout.write(renderMcpGuide(root, port))
}

async function printStatus(environment) {
  const state = await readRuntimeState(environment)
  if (state === undefined || !Number.isInteger(state.pid) || !processExists(state.pid)) {
    process.stdout.write('AgentHarness is not running.\n')
    process.exitCode = 1
    return
  }
  const ready = await endpointReady(state.port)
  process.stdout.write(`AgentHarness ${state.version} process ${state.pid}: ${ready ? `ready at ${state.url}` : 'running without a ready Web endpoint'}\n`)
  const setup = await loadMcpSetup()
  if (setup !== undefined) {
    const clients = await setup.listMcpClients(mcpSetupOptions(commandRoot(environment), state.port, environment))
    process.stdout.write(`MCP clients:\n${renderMcpStatus(clients.clients)}\n`)
  }
  if (!ready) process.exitCode = 1
}

async function printLogs(environment) {
  const path = join(stateRoot(environment), 'server.log')
  try {
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').slice(-80)
    process.stdout.write(`${lines.join('\n')}\n`)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`no AgentHarness log exists at ${path}`)
    throw error
  }
}

async function readSecretFromStdin() {
  if (process.stdin.isTTY) throw new Error('cluster join --secret-stdin requires the secret on standard input')
  let value = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) value += chunk
  return value.replace(/[\r\n]+$/u, '')
}

async function runClusterCommand(args, environment) {
  const [subcommand, ...options] = args
  if (subcommand === 'status') {
    if (options.length > 0) throw new Error('cluster status does not accept options')
    const cluster = await readClusterCredential(environment)
    if (cluster === undefined) {
      process.stdout.write('AgentHarness cluster is not initialized.\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(`AgentHarness cluster ${cluster.clusterId}\nFingerprint: ${cluster.fingerprint}\nCredential source: ${cluster.source}\n`)
    return
  }
  if (subcommand === 'join') {
    const allowed = new Set(['--secret-stdin', '--replace'])
    const unknown = options.find(option => !allowed.has(option))
    if (unknown !== undefined) throw new Error(`unknown cluster join option ${JSON.stringify(unknown)}`)
    if (!options.includes('--secret-stdin')) throw new Error('cluster join requires --secret-stdin; secrets are never accepted in command arguments')
    const cluster = await joinCluster(await readSecretFromStdin(), {
      environment,
      replace: options.includes('--replace'),
    })
    process.stdout.write(`${cluster.changed ? 'Joined' : 'Already joined'} AgentHarness cluster ${cluster.clusterId}\nFingerprint: ${cluster.fingerprint}\n`)
    const state = cluster.changed ? await readRuntimeState(environment) : undefined
    if (state !== undefined && Number.isInteger(state.pid) && processExists(state.pid)) {
      process.stdout.write('Restart AgentHarness before using the new cluster credential.\n')
    }
    return
  }
  throw new Error(`unknown cluster command ${JSON.stringify(subcommand)}; expected status | join`)
}

/** Run one installed AgentHarness management command. */
export async function runInstalledCommand(args, environment = process.env) {
  const [command = 'start', ...rest] = args
  if (command === 'start') return startRuntime(rest, environment)
  if (command === 'stop') return stopRuntime(environment)
  if (command === 'restart') {
    await stopRuntime(environment, true)
    return startRuntime(rest, environment)
  }
  if (command === 'status') return printStatus(environment)
  if (command === 'logs') return printLogs(environment)
  if (command === 'cluster') return runClusterCommand(rest, environment)
  if (command === 'mcp-setup') {
    return configureMcpClients(commandRoot(environment), parsePort(rest, environment), environment)
  }
  if (command === 'mcp-guide') {
    process.stdout.write(renderMcpGuide(commandRoot(environment), parsePort(rest, environment)))
    return
  }
  throw new Error(`unknown command ${JSON.stringify(command)}; expected start | stop | restart | status | logs | cluster | mcp-setup | mcp-guide`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  runInstalledCommand(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`agentharness: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
