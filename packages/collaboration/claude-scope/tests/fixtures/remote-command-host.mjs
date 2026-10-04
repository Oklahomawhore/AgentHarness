/** Real dsh profile composition for two isolated loopback Mesh owners. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Mesh from '@deepseek-ai/dsh-development-mesh-websocket'
import Rooms from '@deepseek-ai/dsh-development-room'
import RoomMesh from '@deepseek-ai/dsh-development-room-mesh'
import * as RoomStorage from '@deepseek-ai/dsh-development-room-storage-domain'
import Tasks from '@deepseek-ai/dsh-development-task'
import TaskMesh from '@deepseek-ai/dsh-development-task-mesh'
import * as TaskStorage from '@deepseek-ai/dsh-development-task-storage-domain'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import Typert from '@deepseek-ai/dsh-typert-registry'
import ClaudeScope from '@deepseek-ai/dsh-claude-scope'

export const name = 'remote-command-host-fixture'

/** Compose shipped providers; the test supplies peer addresses only after both ports are bound. */
export async function apply(ctx, config) {
  const { directory, nodeId, cliPath } = config
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Credentials, { path: join(directory, 'credentials.yml'), dshHome: join(directory, 'home'), watch: false })
  await ctx.plugin(Connection, { maxRequestBodyBytes: 65536 })
  await ctx.plugin(Typert)
  await ctx.plugin(Gateway)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(directory, 'state.sqlite'), journalMode: 'wal' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(Rooms, { nodeId, presenceTtlMs: 60000, maxParticipants: 32, maxRooms: 32, maxTextBytes: 4096 })
  await ctx.plugin(RoomStorage)
  await ctx.plugin(Tasks, {
    maxTasks: 32, maxEventsPerTask: 128, maxMergeParents: 8, maxContextBlockBytes: 65536,
    maxLineageTasks: 64, maxTextBytes: 4096, roomRetryIntervalMs: 10000,
  })
  await ctx.plugin(TaskStorage, { orphanGraceMs: 86400000 })
  await ctx.plugin(TextBackend)
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/', handler(request, response) {
    if (!connection.authorizeIndex(request, response)) return
    response.end('fixture frontend')
  } }), 'remote command fixture: frontend authorization')

  const cancelled = new AbortController()
  ctx.effect(() => () => { cancelled.abort() }, 'remote command fixture: peer discovery cancellation')
  const listeningPath = join(directory, 'listening.json')
  await writeFile(`${listeningPath}.tmp`, JSON.stringify({ nodeId, port: webServer.port }), { flag: 'wx', mode: 0o600 })
  await rename(`${listeningPath}.tmp`, listeningPath)
  const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(20000)])
  let peer
  while (peer === undefined) {
    signal.throwIfAborted()
    try { peer = JSON.parse(await readFile(join(directory, 'peer.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (peer === undefined) await delay(25, undefined, { signal })
  }
  await ctx.plugin(Mesh, {
    path: '/internal/development-mesh', secretRef: 'FIXTURE_MESH_SECRET', peers: [peer],
    discovery: {
      enabled: false, cluster: 'claude-command-fixture', multicastAddress: '239.255.73.67',
      port: 45892, announceIntervalMs: 1000, peerTtlMs: 5000, maxDatagramBytes: 2048,
    },
    reconnectInitialDelayMs: 20, reconnectMaxDelayMs: 100, commandTimeoutMs: 5000,
    maxMessageBytes: 262144, maxEventsPerFrame: 4096,
  })
  await ctx.plugin(RoomMesh)
  await ctx.plugin(TaskMesh)
  await ctx.plugin(ClaudeScope, {
    descriptorPath: join(directory, 'connection.json'), maxSessions: 32, maxLeases: 32, maxProjections: 128,
    maxContextBytes: 9000, maxObservationBytes: 4096, maxArtifactReadBytes: 65536, maxOpenApiSourcesPerSession: 4, contributionPollIntervalMs: 1000,
    setup: {
      home: join(directory, 'home'), profileName: 'claude-hook', launchCommand: process.execPath,
      launchArgs: [cliPath], launchCwd: directory, maxRequestBytes: 262144, maxResponseBytes: 32768,
      timeoutMs: 10000, hookTimeoutSeconds: 30, maxSettingsBytes: 1048576,
    },
  })
}
