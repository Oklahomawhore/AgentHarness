/**
 * Zero-configuration launcher for one colleague's local AgentHarness node.
 * The source checkout and an existing DeepSeek Harness installation share the
 * same DSH_HOME, so the ordinary Web profile keeps all user plugins and state.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureClusterCredential } from './agentharness-cluster.mjs'
import { ensureNodeIdentity } from './agentharness-node-identity.mjs'

export {
  ensureNodeIdentity,
  migrateStandaloneStorageDocument,
  resolveNodeId,
  storedNodeIdentity,
  storedRoomNodeId,
} from './agentharness-node-identity.mjs'

const root = resolve(import.meta.dirname, '..')
const buildStatePath = join(root, 'node_modules', '.agentharness-start-state.json')
const requiredArtifacts = [
  join(root, 'apps', 'cli', 'lib', 'bin.js'),
  join(root, 'apps', 'web', 'dist', 'index.html'),
]

/** Parse launcher-only flags and leave Web flags untouched. */
export function parseArguments(args) {
  const normalized = args.filter(arg => arg !== '--')
  return {
    dryRun: normalized.includes('--dry-run'),
    noOpen: normalized.includes('--no-open'),
    rebuild: normalized.includes('--rebuild'),
    webArgs: normalized.filter(arg => !['--dry-run', '--no-open', '--rebuild'].includes(arg)),
  }
}

/** Resolve the pnpm executable already running this package script. */
export function pnpmInvocation(environment = process.env, nodeExecutable = process.execPath) {
  const npmExecPath = environment.npm_execpath?.trim()
  return npmExecPath === undefined || npmExecPath === ''
    ? { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
    : { command: nodeExecutable, prefix: [npmExecPath] }
}

function hasOption(args, name) {
  return args.some(arg => arg === name || arg.startsWith(`${name}=`))
}

/** Add the single-node product defaults without overriding explicit Web flags. */
export function webArguments(args) {
  return [
    'dsh', 'web',
    ...hasOption(args, '--host') ? [] : ['--host', '127.0.0.1'],
    ...hasOption(args, '--port') ? [] : ['--port', '3080'],
    ...args,
  ]
}

/** Return the loopback URL corresponding to the requested Web port. */
export function localNodeUrl(args) {
  const equals = args.find(arg => arg.startsWith('--port='))?.slice('--port='.length)
  const index = args.indexOf('--port')
  const value = equals ?? (index < 0 ? undefined : args[index + 1]) ?? '3080'
  return /^\d+$/.test(value) && value !== '0' ? `http://127.0.0.1:${value}` : undefined
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function gitSourceState() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (revision.status !== 0 || status.status !== 0) return undefined
  return { revision: revision.stdout.trim(), clean: status.stdout.trim() === '' }
}

async function readBuildState() {
  try {
    const value = JSON.parse(await readFile(buildStatePath, 'utf8'))
    return value?.version === 1 && typeof value.revision === 'string' ? value : undefined
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

/** Decide whether this source revision needs dependency installation and build. */
export function buildRequired({ force, source, recordedRevision, artifactsReady }) {
  return force || source === undefined || !source.clean
    || source.revision !== recordedRevision || !artifactsReady
}

function printCommand(command, args) {
  process.stdout.write(`${[command, ...args].map(value => JSON.stringify(value)).join(' ')}\n`)
}

function runChecked(command, args, dryRun) {
  if (dryRun) {
    printCommand(command, args)
    return
  }
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${args.join(' ')} failed with exit code ${String(result.status ?? 1)}`)
  }
}

async function prepareSource(options, pnpm) {
  const source = gitSourceState()
  const state = await readBuildState()
  const artifactsReady = (await Promise.all(requiredArtifacts.map(fileExists))).every(Boolean)
  const needed = buildRequired({
    force: options.rebuild,
    source,
    recordedRevision: state?.revision,
    artifactsReady,
  })
  if (!needed) return

  runChecked(pnpm.command, [...pnpm.prefix, 'install', '--frozen-lockfile'], options.dryRun)
  runChecked(pnpm.command, [...pnpm.prefix, 'run', 'build'], options.dryRun)
  if (!options.dryRun && source?.clean === true) {
    await writeFile(buildStatePath, `${JSON.stringify({ version: 1, revision: source.revision })}\n`, { mode: 0o600 })
  }
}

/** Wait for the owned CLI's authenticated readiness message, without an anonymous HTTP probe. */
export function waitForNode(child, origin, timeoutMs = 180_000) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const finish = (error, url) => {
      clearTimeout(timer)
      child.stdout.removeListener('data', read)
      child.stderr.removeListener('data', read)
      child.removeListener('error', failed)
      child.removeListener('exit', exited)
      if (error !== undefined) reject(error)
      else resolveReady(url)
    }
    const failed = error => finish(error)
    const exited = () => finish(new Error('the AgentHarness node exited before its Web UI became ready'))
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-16_384)
      const matches = output.matchAll(/dsh web: (https?:\/\/[^\s]+)/gu)
      for (const match of matches) {
        let candidate
        try { candidate = new URL(match[1]) } catch { continue }
        if (candidate.hostname !== '127.0.0.1' || !candidate.searchParams.get('token')) continue
        if (origin !== undefined && candidate.origin !== origin) continue
        finish(undefined, candidate.href)
        return
      }
    }
    const timer = setTimeout(() => {
      finish(new Error(`the AgentHarness node did not become ready within ${String(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('error', failed)
    child.once('exit', exited)
    if (child.exitCode !== null || child.signalCode !== null) exited()
  })
}

/** Resolve the platform browser opener for one loopback URL. */
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/d', '/s', '/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

function openBrowser(url) {
  const opener = browserCommand(process.platform, url)
  const child = spawn(opener.command, opener.args, { cwd: root, detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function runNode(pnpm, args, environment, noOpen) {
  const url = localNodeUrl(args)
  const runtimeEnvironment = {
    ...environment,
    AGENTHARNESS_MCP_NODE: process.execPath,
    AGENTHARNESS_DSH_PATH: join(root, 'apps', 'cli', 'src', 'bin.ts'),
    AGENTHARNESS_MCP_TSCONFIG: join(root, 'tsconfig.base.json'),
    AGENTHARNESS_MCP_NODE_ARGS: JSON.stringify(['--import', import.meta.resolve('tsx/esm')]),
  }
  const child = spawn(pnpm.command, [...pnpm.prefix, ...webArguments(args)], {
    cwd: root,
    env: runtimeEnvironment,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  const exit = new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  const forwardInterrupt = () => { child.kill('SIGINT') }
  const forwardTerminate = () => { child.kill('SIGTERM') }
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTerminate)
  try {
    const authenticatedUrl = await waitForNode(child, url)
    process.stdout.write(`\nAgentHarness node is ready: ${new URL(authenticatedUrl).origin}\n`)
    if (!noOpen) openBrowser(authenticatedUrl)
    const outcome = await exit
    return outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : 1)
  } catch (error) {
    child.kill('SIGTERM')
    await exit.catch(() => {})
    throw error
  } finally {
    process.removeListener('SIGINT', forwardInterrupt)
    process.removeListener('SIGTERM', forwardTerminate)
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const pnpm = pnpmInvocation()
  await prepareSource(options, pnpm)
  const args = webArguments(options.webArgs)
  if (options.dryRun) {
    printCommand(pnpm.command, [...pnpm.prefix, ...args])
    return 0
  }
  const cluster = await ensureClusterCredential()
  const nodeId = await ensureNodeIdentity()
  process.stdout.write(`AgentHarness local node: ${nodeId}; cluster: ${cluster.clusterId} (${cluster.fingerprint})\n`)
  return runNode(pnpm, options.webArgs, {
    ...process.env,
    AGENTHARNESS_CLUSTER: cluster.clusterId,
    AGENTHARNESS_NODE_ID: nodeId,
    DSH_ROOM_NODE_ID: nodeId,
  }, options.noOpen)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`agentharness-start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
