/** Persist and inspect the shared secret that identifies one AgentHarness LAN cluster. */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { isMap, isScalar, parseDocument } from 'yaml'
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

/** Parse both released credential layouts without discarding comments or unrelated records. */
function parseCredentialDocument(text, filename) {
  const document = parseDocument(text ?? '', { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`cannot read credentials document at ${filename}: ${document.errors.map(error => error.code).join(', ')}`)
  }
  if (document.contents === null) {
    document.contents = document.createNode({ version: 1, refs: {} })
    return document
  }
  if (!isMap(document.contents)) throw new Error(`credentials document at ${filename} must be a mapping`)
  if (!document.has('version')) {
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(pair.key.value)
        || !isScalar(pair.value) || typeof pair.value.value !== 'string' || pair.value.value === '') {
        throw new Error(`credentials document at ${filename} must contain version: 1 and credentials under refs`)
      }
    }
    const refs = document.contents
    document.contents = document.createNode({ version: 1 })
    document.set('refs', refs)
  }
  if (document.get('version') !== 1) throw new Error(`credentials document at ${filename} must declare version: 1`)
  for (const pair of document.contents.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key
    if (!['version', 'refs', 'records'].includes(key)) {
      throw new Error(`credentials document at ${filename} contains an unsupported top-level key; keep credentials only under refs, including ${MESH_SECRET_REF}`)
    }
  }
  for (const name of ['refs', 'records']) {
    const section = document.get(name, true)
    if (section !== undefined && !(isScalar(section) && section.value === null) && !isMap(section)) {
      throw new Error(`credentials document at ${filename}: ${name} must be a mapping`)
    }
  }
  const secret = document.getIn(['refs', MESH_SECRET_REF])
  if (secret !== undefined) validateClusterSecret(secret)
  return document
}

async function readCredentialFile(environment) {
  const filename = join(harnessHome(environment), '.credentials.yaml')
  try {
    const info = await stat(filename)
    if (process.platform !== 'win32' && (info.mode & OTHER_USERS_BITS) !== 0) {
      throw new Error(`credentials document at ${filename} must be owner-only; run chmod 600 before retrying`)
    }
    const text = await readFile(filename, 'utf8')
    const document = parseCredentialDocument(text, filename)
    return { document, secret: document.getIn(['refs', MESH_SECRET_REF]) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { document: parseCredentialDocument(undefined, filename), secret: undefined }
    throw error
  }
}

/** Serialize cluster decisions with the provider's other credential writers. */
async function updateStoredSecret(environment, select) {
  // The npm bootstrap only reads credentials; writes run inside the built runtime.
  const { withFileLock, writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write')
  const filename = join(harnessHome(environment), '.credentials.yaml')
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  return withFileLock(filename, async () => {
    const stored = await readCredentialFile(environment)
    const secret = select(stored.secret)
    if (stored.secret !== secret) {
      if (!isMap(stored.document.get('refs', true))) stored.document.set('refs', stored.document.createNode({}))
      stored.document.setIn(['refs', MESH_SECRET_REF], secret)
      await writeFileAtomic(filename, stored.document.toString(), { mode: 0o600, dirMode: 0o700 })
    }
    return { secret, changed: stored.secret !== secret }
  }, { waitMs: 30_000 })
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
  const { secret } = await updateStoredSecret(environment, stored => stored ?? randomBytes(32).toString('base64url'))
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
  const result = await updateStoredSecret(environment, stored => {
    if (stored !== undefined && stored !== secret && options.replace !== true) {
      const current = describeClusterSecret(stored)
      throw new Error(`refusing to replace cluster ${current.clusterId} (${current.fingerprint}); retry with --replace only if the switch is intentional`)
    }
    return secret
  })
  return Object.freeze({ changed: result.changed, source: 'credentials-file', ...describeClusterSecret(secret) })
}
