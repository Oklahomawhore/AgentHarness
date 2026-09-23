/** Persist and inspect the shared secret that identifies one AgentHarness LAN cluster. */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const MESH_SECRET_REF = 'AGENTHARNESS_MESH_SECRET'
const MINIMUM_SECRET_BYTES = 32
const OTHER_USERS_BITS = 0o077

/** Resolve the Harness home used by the ordinary credentials provider. */
export function harnessHome(environment = process.env) {
  const configured = environment.DSH_HOME?.trim()
  if (configured === undefined || configured === '') return join(environment.HOME ?? homedir(), '.dsh')
  if (configured === '~') return environment.HOME ?? homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return join(environment.HOME ?? homedir(), configured.slice(2))
  }
  return resolve(configured)
}

/** Validate a cluster secret without ever including the value in an error. */
export function validateClusterSecret(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < MINIMUM_SECRET_BYTES) {
    throw new Error(`AgentHarness cluster secret must contain at least ${MINIMUM_SECRET_BYTES} UTF-8 bytes`)
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('AgentHarness cluster secret must be one line')
  }
  return value
}

/** Derive non-secret identifiers safe for status output and discovery. */
export function describeClusterSecret(value) {
  const secret = validateClusterSecret(value)
  const digest = createHash('sha256').update(secret, 'utf8').digest('hex')
  return Object.freeze({ clusterId: `agentharness-${digest.slice(0, 12)}`, fingerprint: `sha256:${digest.slice(0, 16)}` })
}

function decodeYamlScalar(value) {
  const source = value.trim()
  if (source.startsWith('"')) {
    try {
      const decoded = JSON.parse(source)
      return typeof decoded === 'string' ? decoded : undefined
    } catch {
      return undefined
    }
  }
  if (source.startsWith("'") && source.endsWith("'")) return source.slice(1, -1).replaceAll("''", "'")
  if (source === '' || source === 'null' || source === '~' || /\s+#/u.test(source)) return undefined
  return source
}

function parseStoredSecret(text, filename) {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    let document
    try {
      document = JSON.parse(trimmed)
    } catch {
      throw new Error(`cannot update malformed credentials document at ${filename}`)
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`credentials document at ${filename} must be a mapping`)
    }
    const value = document[MESH_SECRET_REF]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new Error(`credential ${MESH_SECRET_REF} at ${filename} must be a string`)
    return validateClusterSecret(value)
  }
  const pattern = new RegExp(`^${MESH_SECRET_REF}\\s*:\\s*(.*)$`, 'u')
  const matches = text.split(/\r?\n/u).map(line => pattern.exec(line)).filter(match => match !== null)
  if (matches.length > 1) throw new Error(`credentials document at ${filename} contains duplicate ${MESH_SECRET_REF} keys`)
  if (matches.length === 0) return undefined
  const value = decodeYamlScalar(matches[0][1])
  if (value === undefined) throw new Error(`credential ${MESH_SECRET_REF} at ${filename} must be a one-line string`)
  return validateClusterSecret(value)
}

async function readCredentialFile(environment) {
  const filename = join(harnessHome(environment), '.credentials.yaml')
  try {
    const info = await stat(filename)
    if (process.platform !== 'win32' && (info.mode & OTHER_USERS_BITS) !== 0) {
      throw new Error(`credentials document at ${filename} must be owner-only; run chmod 600 before retrying`)
    }
    const text = await readFile(filename, 'utf8')
    return { filename, text, secret: parseStoredSecret(text, filename) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { filename, text: undefined, secret: undefined }
    throw error
  }
}

function renderCredentialDocument(text, secret, filename) {
  if (text === undefined || text.trim() === '') return `${MESH_SECRET_REF}: ${JSON.stringify(secret)}\n`
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    let document
    try {
      document = JSON.parse(trimmed)
    } catch {
      throw new Error(`cannot update malformed credentials document at ${filename}`)
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`credentials document at ${filename} must be a mapping`)
    }
    return `${JSON.stringify({ ...document, [MESH_SECRET_REF]: secret }, null, 2)}\n`
  }
  const lines = text.replace(/\r\n/gu, '\n').split('\n')
  const pattern = new RegExp(`^${MESH_SECRET_REF}\\s*:`, 'u')
  const indexes = lines.flatMap((line, index) => pattern.test(line) ? [index] : [])
  if (indexes.length > 1) throw new Error(`credentials document at ${filename} contains duplicate ${MESH_SECRET_REF} keys`)
  const rendered = `${MESH_SECRET_REF}: ${JSON.stringify(secret)}`
  if (indexes.length === 1) lines[indexes[0]] = rendered
  else {
    while (lines.at(-1) === '') lines.pop()
    lines.push(rendered)
  }
  return `${lines.join('\n')}\n`
}

async function writeStoredSecret(environment, secret) {
  const stored = await readCredentialFile(environment)
  const text = renderCredentialDocument(stored.text, secret, stored.filename)
  await mkdir(dirname(stored.filename), { recursive: true, mode: 0o700 })
  const temporary = `${stored.filename}.${String(process.pid)}-${randomBytes(4).toString('hex')}.next`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, stored.filename)
    await chmod(stored.filename, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Read the effective cluster without exposing its secret. */
export async function readClusterCredential(environment = process.env) {
  const inherited = environment[MESH_SECRET_REF]
  if (inherited !== undefined && inherited !== '') {
    const secret = validateClusterSecret(inherited)
    return Object.freeze({ secret, source: 'environment', ...describeClusterSecret(secret) })
  }
  const stored = await readCredentialFile(environment)
  if (stored.secret === undefined) return undefined
  return Object.freeze({ secret: stored.secret, source: 'credentials-file', ...describeClusterSecret(stored.secret) })
}

/** Create a private cluster credential only when no effective value exists. */
export async function ensureClusterCredential(environment = process.env) {
  const current = await readClusterCredential(environment)
  if (current !== undefined) return current
  const secret = randomBytes(32).toString('base64url')
  await writeStoredSecret(environment, secret)
  return Object.freeze({ secret, source: 'credentials-file', ...describeClusterSecret(secret) })
}

/** Join one cluster, refusing an accidental cluster replacement. */
export async function joinCluster(secretInput, options = {}) {
  const environment = options.environment ?? process.env
  const secret = validateClusterSecret(secretInput)
  const inherited = environment[MESH_SECRET_REF]
  if (inherited !== undefined && inherited !== '') {
    const active = validateClusterSecret(inherited)
    if (active !== secret) throw new Error(`${MESH_SECRET_REF} from the launching environment shadows the managed credential; unset it before changing clusters`)
    return Object.freeze({ changed: false, source: 'environment', ...describeClusterSecret(active) })
  }
  const stored = await readCredentialFile(environment)
  if (stored.secret !== undefined && stored.secret !== secret && options.replace !== true) {
    const current = describeClusterSecret(stored.secret)
    throw new Error(`refusing to replace cluster ${current.clusterId} (${current.fingerprint}); retry with --replace only if the switch is intentional`)
  }
  if (stored.secret !== secret) await writeStoredSecret(environment, secret)
  return Object.freeze({ changed: stored.secret !== secret, source: 'credentials-file', ...describeClusterSecret(secret) })
}
