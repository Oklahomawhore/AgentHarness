import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  browserCommand,
  buildRequired,
  ensureNodeIdentity,
  localNodeUrl,
  migrateStandaloneStorageDocument,
  parseArguments,
  pnpmInvocation,
  resolveNodeId,
  storedNodeIdentity,
  storedRoomNodeId,
  webArguments,
} from './agentharness-start.mjs'

const launcher = resolve(import.meta.dirname, 'agentharness-start.mjs')
const temporaryHomes: string[] = []

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('AgentHarness single-node launcher', () => {
  it('keeps Web flags while consuming only launcher controls', () => {
    expect(parseArguments(['--', '--no-open', '--rebuild', '--port', '4080'])).toEqual({
      dryRun: false,
      noOpen: true,
      rebuild: true,
      webArgs: ['--port', '4080'],
    })
  })

  it('uses the current pnpm script runtime when available', () => {
    expect(pnpmInvocation({ npm_execpath: '/tools/pnpm.cjs' }, '/node')).toEqual({
      command: '/node',
      prefix: ['/tools/pnpm.cjs'],
    })
  })

  it('defaults to one loopback-only Web node and respects explicit values', () => {
    expect(webArguments([])).toEqual(['dsh', 'web', '--host', '127.0.0.1', '--port', '3080'])
    expect(webArguments(['--host=127.0.0.1', '--port', '4080'])).toEqual([
      'dsh', 'web', '--host=127.0.0.1', '--port', '4080',
    ])
    expect(localNodeUrl([])).toBe('http://127.0.0.1:3080')
    expect(localNodeUrl(['--port=4080'])).toBe('http://127.0.0.1:4080')
    expect(localNodeUrl(['--port', '0'])).toBeUndefined()
  })

  it('uses an explicit, durable, or installation node id before generating one', () => {
    expect(resolveNodeId({ DSH_ROOM_NODE_ID: 'alice-node' }, 'ignored')).toBe('alice-node')
    expect(resolveNodeId({}, 'ignored', 'existing-node', 'persisted-node', 'a1b2c3d4')).toBe('existing-node')
    expect(resolveNodeId({}, 'ignored', 'standalone', 'persisted-node', 'a1b2c3d4')).toBe('persisted-node')
    expect(resolveNodeId({}, 'Alice Mac.local', undefined, undefined, 'a1b2c3d4')).toBe('agentharness-alice-mac-local-a1b2c3d4')
    expect(resolveNodeId({}, '测试', undefined, undefined, 'a1b2c3d4')).toBe('agentharness-node-a1b2c3d4')
  })

  it('accepts only one internally consistent persisted room-log owner', () => {
    expect(storedRoomNodeId({
      unit: { name: 'development_rooms' },
      tables: { logs: { existing: { entries: [{ nodeId: 'existing' }] } } },
    })).toBe('existing')
    expect(storedRoomNodeId({
      unit: { name: 'development_rooms' },
      tables: { logs: { existing: { entries: [{ nodeId: 'other' }] } } },
    })).toBeUndefined()
    expect(storedRoomNodeId({ unit: { name: 'other' }, tables: { logs: {} } })).toBeUndefined()
    expect(storedNodeIdentity({ version: 1, nodeId: 'agentharness-alice-a1b2c3d4' })).toBe('agentharness-alice-a1b2c3d4')
    expect(storedNodeIdentity({ version: 1, nodeId: 'Bad ID' })).toBeUndefined()
  })

  it('rewrites only one internally consistent standalone storage owner', () => {
    const migrated = migrateStandaloneStorageDocument({
      unit: { name: 'development_rooms', version: 8 },
      tables: { logs: { standalone: { entries: [{ nodeId: 'standalone', seq: 1 }] } } },
    }, 'development_rooms', 'agentharness-alice-a1b2c3d4')
    expect(migrated?.tables?.logs).toEqual({
      'agentharness-alice-a1b2c3d4': { entries: [{ nodeId: 'agentharness-alice-a1b2c3d4', seq: 1 }] },
    })
    expect(() => migrateStandaloneStorageDocument({
      unit: { name: 'development_rooms' },
      tables: { logs: { standalone: { entries: [{ nodeId: 'other' }] } } },
    }, 'development_rooms', 'agentharness-alice-a1b2c3d4')).toThrow('cannot be safely assigned')
  })

  it('persists one identity and migrates both legacy local logs with backups', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentharness-node-identity-'))
    temporaryHomes.push(home)
    const storage = join(home, 'storages')
    await mkdir(storage)
    for (const [name, version] of [['development_rooms', 8], ['development_room_context', 1]]) {
      await writeFile(join(storage, `${name}.json`), `${JSON.stringify({
        unit: { name, version },
        tables: { logs: { standalone: { entries: [{ nodeId: 'standalone', seq: 1 }] } } },
      })}\n`)
    }

    const environment = { DSH_HOME: home }
    const first = await ensureNodeIdentity(environment, 'Alice Mac.local', 'a1b2c3d4')
    const second = await ensureNodeIdentity(environment, 'Different Host', 'ffffffff')
    expect(first).toBe('agentharness-alice-mac-local-a1b2c3d4')
    expect(second).toBe(first)
    expect(JSON.parse(await readFile(join(home, 'agentharness-node.json'), 'utf8'))).toEqual({ version: 1, nodeId: first })
    for (const name of ['development_rooms', 'development_room_context']) {
      const document = JSON.parse(await readFile(join(storage, `${name}.json`), 'utf8')) as {
        tables: { logs: Record<string, { entries: Array<{ nodeId: string }> }> }
      }
      expect(document.tables.logs[first]?.entries[0]?.nodeId).toBe(first)
      expect((await readdir(storage)).some(entry =>
        entry.startsWith(`${name}.json.pre-lan-node-id-`))).toBe(true)
    }
  })

  it('rejects malformed installation identity and inconsistent durable room ownership', async () => {
    const invalidIdentityHome = await mkdtemp(join(tmpdir(), 'agentharness-invalid-identity-'))
    temporaryHomes.push(invalidIdentityHome)
    await writeFile(join(invalidIdentityHome, 'agentharness-node.json'), '{"version":1,"nodeId":"Bad ID"}\n')
    await expect(ensureNodeIdentity({ DSH_HOME: invalidIdentityHome })).rejects.toThrow('invalid AgentHarness node identity')

    const inconsistentRoomHome = await mkdtemp(join(tmpdir(), 'agentharness-inconsistent-room-'))
    temporaryHomes.push(inconsistentRoomHome)
    await mkdir(join(inconsistentRoomHome, 'storages'))
    await writeFile(join(inconsistentRoomHome, 'storages', 'development_rooms.json'), `${JSON.stringify({
      unit: { name: 'development_rooms' },
      tables: { logs: { 'node-a': { entries: [{ nodeId: 'node-b' }] } } },
    })}\n`)
    await expect(ensureNodeIdentity({ DSH_HOME: inconsistentRoomHome }))
      .rejects.toThrow('has no single consistent node owner')
  })

  it('rebuilds only for source or artifact drift', () => {
    const source = { revision: 'abc', clean: true }
    expect(buildRequired({ force: false, source, recordedRevision: 'abc', artifactsReady: true })).toBe(false)
    expect(buildRequired({ force: true, source, recordedRevision: 'abc', artifactsReady: true })).toBe(true)
    expect(buildRequired({ force: false, source: { ...source, clean: false }, recordedRevision: 'abc', artifactsReady: true })).toBe(true)
    expect(buildRequired({ force: false, source, recordedRevision: 'old', artifactsReady: true })).toBe(true)
    expect(buildRequired({ force: false, source, recordedRevision: 'abc', artifactsReady: false })).toBe(true)
  })

  it('uses each platform browser opener', () => {
    expect(browserCommand('darwin', 'http://127.0.0.1:3080')).toEqual({
      command: 'open', args: ['http://127.0.0.1:3080'],
    })
    expect(browserCommand('linux', 'http://127.0.0.1:3080')).toEqual({
      command: 'xdg-open', args: ['http://127.0.0.1:3080'],
    })
  })

  it('dry-runs without installing, building, or starting a process', () => {
    const output = execFileSync(process.execPath, [launcher, '--dry-run', '--no-open'], {
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: '/tools/pnpm.cjs' },
    })
    expect(output).toContain('"install" "--frozen-lockfile"')
    expect(output).toContain('"run" "build"')
    expect(output).toContain('"dsh" "web" "--host" "127.0.0.1" "--port" "3080"')
    expect(output).not.toContain('docker')
  })
})
