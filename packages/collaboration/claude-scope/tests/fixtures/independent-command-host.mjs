/** Real public-package composition with independent identities and no legacy replication. */

import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Rooms from '@deepseek-ai/dsh-development-room'
import * as RoomStorage from '@deepseek-ai/dsh-development-room-storage-domain'
import Tasks from '@deepseek-ai/dsh-development-task'
import * as TaskStorage from '@deepseek-ai/dsh-development-task-storage-domain'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import FactsBackend from '@deepseek-ai/dsh-development-task-context/facts'
import { mountNativeRecipient } from './independent-native-recipient.mjs'
import ScopeTransport from '@deepseek-ai/dsh-scope-transport/libp2p'
import ScopeAccess from '@deepseek-ai/dsh-scope-access'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import Typert from '@deepseek-ai/dsh-typert-registry'
import ClaudeScope from '@deepseek-ai/dsh-claude-scope'

export const name = 'independent-command-host-fixture'

/** Start a direct-address Host; the test owns the temporary home, database, and lifecycle. */
export async function apply(ctx, config) {
  const { directory, nodeId, cliPath, listenAddress } = config
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
  if (config.factsBackend) await ctx.plugin(FactsBackend, {
    routes: [{ responsibility: 'frontend', fields: ['requiredRequestFields'] }],
    unmatchedFields: ['operationId', 'requestBodyRequired', 'requiredRequestFields', 'responseStatuses', 'deprecated'],
  })
  else await ctx.plugin(TextBackend)
  const admittedWatches = new Map()
  const watchAdmissions = new Map()
  class ObservedTransport extends ScopeTransport {
    register(protocol, handler) {
      if (protocol !== '/agentharness/scope-watch/1') return super.register(protocol, handler)
      return super.register(protocol, async input => {
        const id = input.payload.requestId
        admittedWatches.set(id, true)
        watchAdmissions.get(id)?.resolve()
        try { return await handler(input) } finally { admittedWatches.set(id, false) }
      })
    }
  }
  await ctx.plugin(ObservedTransport, {
    listenAddresses: [listenAddress], maxRequestBytes: 65536, maxResponseBytes: 65536,
    maxInboundRequests: 8, maxOutboundRequests: 8, maxConnections: 8,
    requestTimeoutMs: 65000, connectionTimeoutMs: 3000,
  })
  await ctx.plugin(ScopeAccess, {
    maxGrants: 32, maxSubscriptions: 32, maxProjections: 128, maxContextBytes: 6000,
    maxResponseBytes: 16384, maxDecodedResponseBytes: 2097152, requestTimeoutMs: 65000, maxInvitationLifetimeMs: 900000, maxConcurrentReads: 8,
    // The test's HTTP deadline expires before this timer: only a change can satisfy its wait.
    waitTimeoutMs: 60000, maxConcurrentWaits: 2,
    maxConcurrentContributions: 2, maxContributionRequestBytes: 16384, maxContributionApplications: 16, maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 60000,
  })
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  const transport = ctx.get('scopeTransport')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/', handler(request, response) {
    if (!connection.authorizeIndex(request, response)) return
    response.end('fixture frontend')
  } }), 'independent command fixture: frontend authorization')

  // This fixture-only route lets a third authenticated device exercise malformed
  // peer requests without widening the product's local management API.
  const shutdown = new AbortController()
  const probes = new Set()
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/fixture/scope-read', handler(request, response) {
    const rejected = connection.requestRejection(request)
    if (rejected !== undefined) { response.writeHead(rejected); response.end(); return }
    const probe = (async () => {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 65536) throw new Error('fixture request exceeds byte bound')
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      let result
      if (input.kind === 'watch-admission') {
        if (!admittedWatches.has(input.requestId)) {
          const admission = Promise.withResolvers()
          watchAdmissions.set(input.requestId, admission)
          const abort = () => admission.reject(shutdown.signal.reason)
          shutdown.signal.throwIfAborted()
          shutdown.signal.addEventListener('abort', abort, { once: true })
          try { await admission.promise } finally {
            shutdown.signal.removeEventListener('abort', abort)
            watchAdmissions.delete(input.requestId)
          }
        }
        result = { active: admittedWatches.get(input.requestId) }
      } else if (input.kind === 'watch-state') {
        result = { active: admittedWatches.get(input.requestId) }
      } else {
        result = await transport.request(input.target, input.protocol, input.payload, shutdown.signal)
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(result))
    })()
    probes.add(probe)
    void probe.catch(() => {
      response.statusCode = 500
      response.end('fixture transport request failed')
    }).finally(() => probes.delete(probe))
  } }), 'independent command fixture: authenticated adversarial probe')
  ctx.effect(() => async () => {
    shutdown.abort()
    await Promise.allSettled(probes)
  }, 'independent command fixture: probe quiescence')
  if (config.nativeRecipient) await mountNativeRecipient(ctx)
  await ctx.plugin(ClaudeScope, {
    descriptorPath: join(directory, 'connection.json'), maxSessions: 32, maxLeases: 32, maxProjections: 128,
    maxContextBytes: 9000, maxObservationBytes: 4096, maxArtifactReadBytes: 65536, maxOpenApiSourcesPerSession: 4, contributionPollIntervalMs: 1000,
    setup: {
      home: join(directory, 'home'), profileName: 'claude-hook', launchCommand: process.execPath,
      launchArgs: [cliPath], launchCwd: directory, maxRequestBytes: 262144, maxResponseBytes: 32768,
      timeoutMs: 10000, hookTimeoutSeconds: 30, maxSettingsBytes: 1048576,
    },
  })
  const identity = await transport.identity()
  const path = join(directory, 'identity.json')
  await writeFile(`${path}.tmp`, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
  await rename(`${path}.tmp`, path)
}
