/**
 * Zero-configuration launcher for the three-node AgentHarness development room.
 * It reuses a healthy Compose project, otherwise passes the host's existing
 * Gitee credential through a temporary Docker secret until all nodes are healthy.
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const composeFile = 'acceptance/development-room/compose.yaml'
const services = ['node-a', 'node-b', 'node-c']

/** Stable node URLs printed after the Compose health checks pass. */
export const nodeUrls = Object.freeze([
  Object.freeze({ service: 'node-a', role: 'frontend', url: 'http://127.0.0.1:3081' }),
  Object.freeze({ service: 'node-b', role: 'backend', url: 'http://127.0.0.1:3082' }),
  Object.freeze({ service: 'node-c', role: 'algorithm', url: 'http://127.0.0.1:3083' }),
])

/**
 * Parse the launcher's closed flag set.
 * @param {string[]} args - Command-line arguments after the script path.
 * @returns {{ dryRun: boolean, help: boolean, noOpen: boolean, openAll: boolean, rebuild: boolean }} Parsed options.
 */
export function parseArguments(args) {
  const normalized = args.filter(arg => arg !== '--')
  const known = new Set(['--dry-run', '--help', '-h', '--no-open', '--open-all', '--rebuild'])
  const unknown = normalized.find(arg => !known.has(arg))
  if (unknown !== undefined) throw new Error(`unknown option ${JSON.stringify(unknown)}; run with --help`)
  return {
    dryRun: normalized.includes('--dry-run'),
    help: normalized.includes('--help') || normalized.includes('-h'),
    noOpen: normalized.includes('--no-open'),
    openAll: normalized.includes('--open-all'),
    rebuild: normalized.includes('--rebuild'),
  }
}

/**
 * Parse git-credential's line protocol without logging its values.
 * @param {string} output - `git credential fill` standard output.
 * @returns {Record<string, string>} Credential fields.
 */
export function parseCredential(output) {
  return Object.fromEntries(output
    .split(/\r?\n/u)
    .filter(line => line.includes('='))
    .map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
}

/**
 * Build the Compose up arguments for normal reuse or an explicit clean rebuild.
 * @param {{ rebuild: boolean }} options - Launch mode.
 * @returns {string[]} Docker CLI arguments.
 */
export function composeUpArguments(options) {
  return [
    'compose', '-f', composeFile,
    'up', '-d', '--build',
    ...options.rebuild ? ['--force-recreate'] : [],
    '--wait', '--wait-timeout', '300',
  ]
}

/**
 * Decide whether every required service has one healthy container.
 * @param {string[]} containerIds - Compose container ids in service order.
 * @param {string[]} healthStates - Docker health states in the same order.
 * @returns {boolean} Whether the existing environment is reusable.
 */
export function allNodesHealthy(containerIds, healthStates) {
  return containerIds.length === services.length
    && healthStates.length === services.length
    && healthStates.every(state => state === 'healthy')
}

/**
 * Resolve the platform command that opens a URL in the default browser.
 * @param {NodeJS.Platform} platform - Node platform identifier.
 * @param {string} url - HTTP URL to open.
 * @returns {{ command: string, args: string[] }} Browser-launch command.
 */
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/d', '/s', '/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

function usage() {
  process.stdout.write(`Usage: pnpm run development-room:up [--no-open] [--open-all] [--rebuild] [--dry-run]\n\n`
    + '  --no-open   print URLs without opening a browser\n'
    + '  --open-all  open all three node URLs instead of node-a only\n'
    + '  --rebuild   force container recreation after an AgentHarness update\n'
    + '  --dry-run   print the action without reading credentials or using Docker\n')
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function requireDockerCompose() {
  const result = runSync('docker', ['compose', 'version'])
  if (result.error !== undefined) throw new Error('Docker is not available; install and start Docker Desktop, then run the same command again')
  if (result.status !== 0) throw new Error('Docker Compose is not available; start Docker Desktop, then run the same command again')
}

function currentHealth() {
  const containers = runSync('docker', ['compose', '-f', composeFile, 'ps', '-q', ...services])
  if (containers.status !== 0) return false
  const containerIds = containers.stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  const healthStates = containerIds.map((containerId) => {
    const inspected = runSync('docker', [
      'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerId,
    ])
    return inspected.status === 0 ? inspected.stdout.trim() : ''
  })
  return allNodesHealthy(containerIds, healthStates)
}

function readGiteeCredential() {
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd: root,
    input: 'protocol=https\nhost=gitee.com\n\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Gitee credentials are unavailable; sign in to gitee.com with Git, then run the same command again')
  }
  const credential = parseCredential(result.stdout)
  if (credential.username === undefined || credential.password === undefined) {
    throw new Error('Gitee credentials are not stored; complete one authenticated gitee.com Git operation, then run the same command again')
  }
  return credential
}

async function runCompose(credential, options) {
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'agentharness-gitee-credential-'))
  const credentialFile = join(credentialDirectory, 'credentials')
  const encodedCredential = `https://${encodeURIComponent(credential.username)}:${encodeURIComponent(credential.password)}@gitee.com\n`
  await writeFile(credentialFile, encodedCredential, { mode: 0o600 })
  await chmod(credentialFile, 0o600)

  try {
    const exitCode = await new Promise((resolvePromise, reject) => {
      const child = spawn('docker', composeUpArguments(options), {
        cwd: root,
        env: {
          ...process.env,
          AGENTHARNESS_GIT_CREDENTIALS_ENABLED: '1',
          AGENTHARNESS_GIT_CREDENTIALS_FILE: credentialFile,
        },
        stdio: 'inherit',
      })
      child.once('error', reject)
      child.once('exit', code => resolvePromise(code ?? 1))
    })
    if (exitCode !== 0) throw new Error(`three-node startup failed with exit code ${String(exitCode)}`)
  } finally {
    await rm(credentialDirectory, { recursive: true, force: true })
  }
}

function printReady(reused) {
  process.stdout.write(`\nAgentHarness alpha is ready${reused ? ' (reused the healthy environment)' : ''}.\n`)
  for (const node of nodeUrls) process.stdout.write(`  ${node.service} / ${node.role}: ${node.url}\n`)
  process.stdout.write('\nStop later with: npx --yes pnpm@11.7.0 run development-room:down\n')
}

function openBrowser(options) {
  if (options.noOpen) return
  const targets = options.openAll ? nodeUrls : nodeUrls.slice(0, 1)
  for (const { url } of targets) {
    const opener = browserCommand(process.platform, url)
    try {
      const child = spawn(opener.command, opener.args, { cwd: root, detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    } catch {
      // The printed URL remains the supported fallback when no desktop opener exists.
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  if (options.dryRun) {
    process.stdout.write(`docker ${composeUpArguments(options).join(' ')}\n`)
    printReady(false)
    return
  }

  requireDockerCompose()
  if (!options.rebuild && currentHealth()) {
    printReady(true)
    openBrowser(options)
    return
  }

  const credential = readGiteeCredential()
  await runCompose(credential, options)
  if (!currentHealth()) throw new Error('Compose completed but one or more AgentHarness nodes are not healthy')
  printReady(false)
  openBrowser(options)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error) => {
    process.stderr.write(`development-room: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
