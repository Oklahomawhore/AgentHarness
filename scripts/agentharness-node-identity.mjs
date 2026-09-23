/** Resolve and persist one stable local collaboration node identity before room storage loads. */

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

const NODE_IDENTITY_VERSION = 1
const LEGACY_NODE_ID = 'standalone'
const NODE_PATTERN = /^[a-z][a-z0-9-]*$/u

/** Select an explicit, durable-log, installation, or newly generated local node id. */
export function resolveNodeId(environment = process.env, host = hostname(), storedNodeId, persistedNodeId, entropy = randomBytes(4).toString('hex')) {
  const configured = environment.DSH_ROOM_NODE_ID?.trim()
  if (configured !== undefined && configured !== '') return configured
  if (storedNodeId !== undefined && storedNodeId !== LEGACY_NODE_ID) return storedNodeId
  if (persistedNodeId !== undefined) return persistedNodeId
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48)
  const prefix = slug === '' ? 'node' : slug
  return `agentharness-${prefix}-${entropy}`
}

/** Read one valid owner id from the development-room storage document. */
export function storedRoomNodeId(value) {
  const logs = value?.unit?.name === 'development_rooms' ? value?.tables?.logs : undefined
  if (logs === null || typeof logs !== 'object' || Array.isArray(logs)) return undefined
  const records = Object.entries(logs)
  if (records.length !== 1) return undefined
  const [nodeId, record] = records[0]
  const entries = record?.entries
  if (nodeId.trim() === '' || !Array.isArray(entries) || entries.length === 0) return undefined
  return entries.every(entry => entry?.nodeId === nodeId) ? nodeId : undefined
}

/** Read one valid installation identity record. */
export function storedNodeIdentity(value) {
  const nodeId = value?.version === NODE_IDENTITY_VERSION ? value?.nodeId : undefined
  return typeof nodeId === 'string' && NODE_PATTERN.test(nodeId) ? nodeId : undefined
}

/** Rewrite one legacy standalone storage document to a stable installation id. */
export function migrateStandaloneStorageDocument(value, expectedName, nodeId) {
  if (value?.unit?.name !== expectedName) return undefined
  const logs = value?.tables?.logs
  if (logs === null || typeof logs !== 'object' || Array.isArray(logs)) return undefined
  const legacy = logs[LEGACY_NODE_ID]
  if (legacy === undefined) return undefined
  if (Object.keys(logs).length !== 1 || !Array.isArray(legacy?.entries) || legacy.entries.length === 0
    || !legacy.entries.every(entry => entry?.nodeId === LEGACY_NODE_ID)) {
    throw new Error(`legacy AgentHarness storage ${expectedName} cannot be safely assigned to ${nodeId}`)
  }
  return {
    ...value,
    tables: {
      ...value.tables,
      logs: {
        [nodeId]: {
          ...legacy,
          entries: legacy.entries.map(entry => ({ ...entry, nodeId })),
        },
      },
    },
  }
}

function harnessHome(environment = process.env) {
  const configured = environment.DSH_HOME?.trim()
  if (configured === undefined || configured === '') return join(homedir(), '.dsh')
  const expanded = configured === '~'
    ? homedir()
    : configured.startsWith('~/') || configured.startsWith('~\\')
      ? join(homedir(), configured.slice(2))
      : configured
  return resolve(expanded)
}

async function readStoredRoomNodeId(environment = process.env) {
  try {
    const path = join(harnessHome(environment), 'storages', 'development_rooms.json')
    const value = JSON.parse(await readFile(path, 'utf8'))
    const logs = value?.unit?.name === 'development_rooms' ? value?.tables?.logs : undefined
    if (logs === null || typeof logs !== 'object' || Array.isArray(logs)) {
      throw new Error(`invalid AgentHarness room storage at ${path}`)
    }
    const nodeId = storedRoomNodeId(value)
    if (nodeId === undefined && Object.keys(logs).length > 0) {
      throw new Error(`AgentHarness room storage at ${path} has no single consistent node owner`)
    }
    return nodeId
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readPersistedNodeId(environment = process.env) {
  const path = join(harnessHome(environment), 'agentharness-node.json')
  try {
    const value = storedNodeIdentity(JSON.parse(await readFile(path, 'utf8')))
    if (value === undefined) throw new Error(`invalid AgentHarness node identity at ${path}`)
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeIdentity(path, nodeId, exclusive) {
  const document = `${JSON.stringify({ version: NODE_IDENTITY_VERSION, nodeId }, null, 2)}\n`
  if (exclusive) {
    try {
      await writeFile(path, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return nodeId
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const winner = storedNodeIdentity(JSON.parse(await readFile(path, 'utf8')))
      if (winner === undefined) throw new Error(`invalid AgentHarness node identity at ${path}`)
      return winner
    }
  }
  const target = `${path}.${String(process.pid)}-${randomBytes(4).toString('hex')}.next`
  try {
    await writeFile(target, document, { encoding: 'utf8', mode: 0o600 })
    await rename(target, path)
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
  return nodeId
}

async function migrateStandaloneStorage(environment, name, nodeId) {
  const path = join(harnessHome(environment), 'storages', `${name}.json`)
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const migrated = migrateStandaloneStorageDocument(JSON.parse(source), name, nodeId)
  if (migrated === undefined) return
  const marker = `${String(Date.now())}-${randomBytes(4).toString('hex')}`
  const backup = `${path}.pre-lan-node-id-${marker}`
  const target = `${path}.${marker}.next`
  await copyFile(path, backup)
  try {
    await writeFile(target, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 })
    await rename(target, path)
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
  process.stdout.write(`migrated legacy ${name} node id; backup: ${backup}\n`)
}

/** Persist one installation identity and migrate legacy standalone logs before boot. */
export async function ensureNodeIdentity(environment = process.env, host = hostname(), entropy = randomBytes(4).toString('hex')) {
  const configured = environment.DSH_ROOM_NODE_ID?.trim()
  if (configured !== undefined && configured !== '') {
    await migrateStandaloneStorage(environment, 'development_rooms', configured)
    await migrateStandaloneStorage(environment, 'development_room_context', configured)
    return configured
  }

  const home = harnessHome(environment)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const storedNodeId = await readStoredRoomNodeId(environment)
  const persistedNodeId = await readPersistedNodeId(environment)
  const identityPath = join(home, 'agentharness-node.json')
  let nodeId = resolveNodeId(environment, host, storedNodeId, persistedNodeId, entropy)
  if (persistedNodeId === undefined) nodeId = await writeIdentity(identityPath, nodeId, true)
  else if (persistedNodeId !== nodeId) nodeId = await writeIdentity(identityPath, nodeId, false)

  await migrateStandaloneStorage(environment, 'development_rooms', nodeId)
  await migrateStandaloneStorage(environment, 'development_room_context', nodeId)
  return nodeId
}
