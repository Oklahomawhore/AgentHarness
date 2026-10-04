/** Private named dsh profile: production scope services and optional native evaluation Session. */
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mountNativeSession, mountDataSemantic } from './native-session.mjs'

export const name = 'scope-evaluation-native-profile'

/** Mount explicitly configured production services; all credentials and storage belong to this run.
 * @param ctx Profile-owned Cordis context.
 * @param config Private module URLs, directories, role, and finite resource limits.
 */
export async function apply(ctx, config) {
  const modules = Object.fromEntries(await Promise.all(Object.entries(config.modules).map(async ([key, url]) => [key, await import(url)])))
  const mount = (key, options) => ctx.plugin(modules[key].default ?? modules[key], options)
  await mount('Web', { host: '127.0.0.1', port: 0 })
  await mount('Credentials', { path: join(config.directory, 'credentials.yml'), dshHome: join(config.directory, 'home'), watch: false })
  await mount('Connection', { maxRequestBodyBytes: 262144 })
  await mount('Typert'); await mount('Gateway'); await mount('Storage')
  await mount('Sqlite', { path: join(config.directory, 'state.sqlite'), journalMode: 'wal' })
  await mount('Domain', { backend: 'sqlite' })
  await mount('Rooms', { nodeId: config.nodeId, presenceTtlMs: 60000, maxParticipants: 32, maxRooms: 32, maxTextBytes: 4096 })
  await mount('RoomStorage')
  await mount('Tasks', { maxTasks: 32, maxEventsPerTask: 128, maxMergeParents: 8, maxContextBlockBytes: 65536,
    maxLineageTasks: 64, maxTextBytes: 8192, roomRetryIntervalMs: 10000 })
  await mount('TaskStorage', { orphanGraceMs: 86400000 })
  let manage
  if (config.data === undefined) await mount('Facts', { routes: [
    { responsibility: 'frontend', fields: ['operationId', 'requestBodyRequired', 'requiredRequestFields', 'deprecated'] },
    { responsibility: 'qa', fields: ['operationId', 'requestBodyRequired', 'requiredRequestFields', 'responseStatuses', 'deprecated'] },
  ], unmatchedFields: ['operationId', 'requestBodyRequired', 'requiredRequestFields', 'responseStatuses', 'deprecated'] })
  if (config.data !== undefined) {
    if (config.data.condition === 'R' && config.data.role === 'O') manage = await mountDataSemantic(ctx, config.data, modules)
    else await mount('Text')
  }
  const peerTimeoutMs = config.data?.peerTimeoutMs ?? 30000
  await mount('Transport', { listenAddresses: ['/ip4/127.0.0.1/tcp/0'], maxRequestBytes: config.data === undefined ? 65536 : 262144, maxResponseBytes: config.data === undefined ? 65536 : 262144,
    maxInboundRequests: 8, maxOutboundRequests: 8, maxConnections: 8, requestTimeoutMs: peerTimeoutMs, connectionTimeoutMs: 3000 })
  await mount('Access', { maxGrants: 32, maxSubscriptions: 32, maxProjections: 128, maxContextBytes: config.data?.contextBytes ?? 8000,
    maxResponseBytes: config.data === undefined ? 32768 : 131072, requestTimeoutMs: peerTimeoutMs,
    maxInvitationLifetimeMs: config.data === undefined ? 900000 : 3600000, maxConcurrentReads: 8,
    waitTimeoutMs: 20000, maxConcurrentWaits: 2, maxConcurrentContributions: 2, maxContributionRequestBytes: config.data === undefined ? 16384 : 32768,
    maxContributionApplications: 16, maxApplicationRequestBytes: config.data === undefined ? 16384 : 32768,
    maxApplicationLifetimeMs: config.data === undefined ? 86400000 : 3600000 })
  const web = ctx.get('webServer')
  const connection = ctx.get('connection')
  ctx.effect(() => web.register({ kind: 'exact', path: '/', handler(request, response) {
    if (connection.authorizeIndex(request, response)) response.end('Controlled evaluation')
  } }), 'evaluation connection authorization')
  if (config.native !== undefined) manage = await mountNativeSession(ctx, config.native, modules)
  if (manage !== undefined) {
    const operations = new Set()
    ctx.effect(() => web.register({ kind: 'exact', path: '/evaluation/session', handler(request, response) {
      if (connection.requestRejection(request) !== undefined) { response.writeHead(401); response.end(); return }
      const operation = (async () => {
        const chunks = []; let bytes = 0
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > 1024) throw new Error('management request too large')
          chunks.push(chunk)
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (input === null || typeof input !== 'object' || Object.keys(input).length !== 1
          || !['status', 'start', 'finish', 'cancel'].includes(input.kind)) throw new Error('invalid management action')
        const value = await manage.invoke(input)
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value))
      })()
      operations.add(operation)
      void operation.catch(() => { response.statusCode = 500; response.end('native evaluation failed') })
        .finally(() => operations.delete(operation))
    } }), 'evaluation native management')
    ctx.effect(() => async () => { await manage.stop(); await Promise.allSettled(operations) }, 'evaluation management drain')
  }
  await mount('Claude', { descriptorPath: join(config.directory, 'connection.json'), maxSessions: 32, maxLeases: 32,
    maxProjections: 128, maxContextBytes: 10000, maxObservationBytes: 4096, maxArtifactReadBytes: 65536, contributionPollIntervalMs: 1000,
    maxOpenApiSourcesPerSession: 4, setup: { home: join(config.directory, 'home'), profileName: 'evaluation-hook',
      launchCommand: process.execPath, launchArgs: [config.cliPath], launchCwd: config.directory,
      maxRequestBytes: 262144, maxResponseBytes: 32768, timeoutMs: 10000, hookTimeoutSeconds: 30, maxSettingsBytes: 1048576 } })
  const identity = await ctx.get('scopeTransport').identity()
  const path = join(config.directory, 'identity.json')
  await writeFile(`${path}.tmp`, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
  await rename(`${path}.tmp`, path)
}
