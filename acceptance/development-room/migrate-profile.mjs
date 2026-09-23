import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const dshHome = process.env.DSH_HOME
if (dshHome === undefined || dshHome.trim() === '') throw new Error('DSH_HOME is required')

const manifestPath = resolve(dshHome, 'profiles/web/package.json')
let source
try {
  source = await readFile(manifestPath, 'utf8')
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0)
  throw error
}

const manifest = JSON.parse(source)
const bundles = manifest.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  manifest.dsh.profile.bundles = bundles.filter(name =>
    typeof name !== 'string' || !name.startsWith('@agentharness/'))
}
if (manifest.dependencies !== undefined && manifest.dependencies !== null) {
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies)
    .filter(([name]) => !name.startsWith('@agentharness/')))
}

const target = `${manifestPath}.next`
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
await rename(target, manifestPath)
process.stdout.write(`migrated legacy AgentHarness profile manifest under ${dirname(manifestPath)}\n`)

const storageVersions = new Map([
  ['development_rooms', 8],
  ['development_room_context', 1],
])
for (const [name, expectedVersion] of storageVersions) {
  const storagePath = resolve(dshHome, 'storages', `${name}.json`)
  let document
  try {
    document = JSON.parse(await readFile(storagePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') continue
    throw error
  }
  const storedVersion = document?.unit?.version
  if (storedVersion === expectedVersion) continue
  if (!Number.isSafeInteger(storedVersion)) {
    throw new Error(`legacy AgentHarness storage ${storagePath} has no valid unit version`)
  }
  const backupPath = `${storagePath}.legacy-v${String(storedVersion)}-${String(Date.now())}`
  await rename(storagePath, backupPath)
  process.stdout.write(`preserved incompatible ${name} storage as ${backupPath}\n`)
}
