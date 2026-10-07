/** Test-only observation of shipped Web composition; all calls use its production services. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

export const name = 'scope-semantic-profile-observer'
export const inject = ['webServer', 'connection', 'loader', 'appReady', 'scopeAccess', 'developmentTasks',
  'developmentRooms', 'sessions', 'sessionPersistence', 'sessionQuery', 'developmentTaskContextBackend', 'claudeScope']

/** Register authenticated fixture operations and publish readiness after the full profile starts.
 * @param ctx The ordinary, non-audit Web context.
 * @param config Private readiness file and project directory.
 */
export function apply(ctx, config) {
  const lifetime = new AbortController()
  const operations = new Set()
  const service = (key) => {
    const value = ctx.get(key)
    assert(value !== undefined, `missing profile service: ${key}`)
    return value
  }
  const entry = (id) => {
    const value = [...service('loader').entries()].find(row => row.options.id === id)
    assert(value !== undefined, `missing profile entry: ${id}`)
    return value
  }
  const resolved = () => {
    const transport = entry('scope-transport-libp2p').fiber.config
    const access = entry('scope-access').fiber.config
    const claude = entry('claude-scope').fiber.config
    const configured = entry('development-task-context-backend')
    const group = entry('development-task-context-audit')
    assert.equal(configured.options.name, '@deepseek-ai/dsh-development-task-context/configured')
    assert.equal(configured.disabled, false)
    assert.equal(group.options.group, true)
    assert.deepEqual(group.options.isolate, { sessionPersistence: true })
    assert.equal(configured.parent, group.subgroup)
    const providers = Object.getOwnPropertySymbols(ctx.reflect.store).map(key => ctx.reflect.store[key])
      .filter(impl => impl?.name === 'developmentTaskContextBackend')
    assert.equal(providers.length, 1, 'the profile owns exactly one context backend provider')
    // Cordis exposes traceable Fiber proxies; uid identifies the instance within this registry.
    assert.equal(providers[0].fiber.parent.fiber.uid, configured.fiber.uid)
    const backend = service('developmentTaskContextBackend').identity
    return { backend, configured: { module: configured.options.name, enabled: !configured.disabled,
      groupId: group.options.id, providerCount: providers.length, selection: configured.fiber.config.selection },
      transportTimeoutMs: transport.requestTimeoutMs, connectionTimeoutMs: transport.connectionTimeoutMs,
      accessTimeoutMs: access.requestTimeoutMs, waitTimeoutMs: access.waitTimeoutMs,
      hook: { profileName: claude.setup.profileName, timeoutMs: claude.setup.timeoutMs,
        hookTimeoutSeconds: claude.setup.hookTimeoutSeconds }, semantic: backend.id === 'semantic' ? providers[0].fiber.config : null }
  }
  const invoke = async (input) => {
    const access = service('scopeAccess')
    switch (input.kind) {
      case 'identity': return await access.identity()
      case 'create': {
        const participantId = 'semantic-profile-human'
        await service('developmentRooms').announce({ id: participantId, kind: 'human', displayName: 'Profile fixture owner' })
        const task = await service('developmentTasks').create({ origin: { kind: 'root' },
          objective: 'Implement the retry client', scope: 'Client retry behavior', createdBy: participantId })
        await service('developmentTasks').publishContext({ taskId: task.id, participantId,
          text: 'RETRY_PROFILE_CANARY: Keep retryCount=3. Never retry validation errors.' })
        return task
      }
      case 'invite': return await access.invite(input.request)
      case 'join': return await access.join({ invitation: input.invitation })
      case 'read': return await access.retrieve(input.subscriptionId, lifetime.signal)
      case 'revoke': await access.revoke({ grantId: input.grantId }); return { revoked: true }
      case 'setup': return await service('claudeScope').setup({ projectPath: config.project })
      case 'inspect': {
        const id = 'scope-context-audit'
        const ordinary = service('sessionPersistence')
        const query = service('sessionQuery')
        const audit = entry('scope-context-audit-persistence').ctx.get('sessionPersistence')
        assert(audit !== undefined)
        const handle = await audit.open(id, 'read')
        let events
        try { events = (await handle.read()).events } finally { await handle.close() }
        assert.equal(await ordinary.stat(id), undefined)
        await assert.rejects(query.readSession(id), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        const listed = await ordinary.list()
        const queried = await query.listSessions()
        const searched = await query.searchSessions({ query: 'RETRY_PROFILE_CANARY' })
        assert(!service('sessions').list().some(row => row.id === id))
        assert(!listed.some(row => row.header.id === id))
        assert(!queried.some(row => row.header.id === id))
        assert.equal(searched.items.length, 0)
        return { events, isolated: true, ...resolved() }
      }
      default: throw new Error('unknown fixture operation')
    }
  }
  ctx.effect(() => service('webServer').register({ kind: 'exact', path: '/__scope_semantic_fixture', handler(request, response) {
    if (service('connection').requestRejection(request) !== undefined) { response.writeHead(401); response.end(); return }
    const work = (async () => {
      const chunks = []; let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        assert(bytes <= 32768, 'fixture request exceeds its bound')
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const result = await invoke(input)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(result))
    })()
    operations.add(work)
    void work.catch((error) => { response.writeHead(500); response.end(String(error)) })
      .finally(() => operations.delete(work))
  } }), 'profile fixture endpoint')
  ctx.effect(() => service('appReady').onReady(async () => {
    await service('scopeAccess').identity()
    await writeFile(config.ready, JSON.stringify(resolved()), { flag: 'wx' })
  }), 'profile fixture readiness')
  ctx.effect(() => async () => {
    lifetime.abort(new Error('profile fixture disposed'))
    await Promise.allSettled(operations)
  }, 'profile fixture quiescence')
}
