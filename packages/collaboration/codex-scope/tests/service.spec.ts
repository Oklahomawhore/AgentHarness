import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import CodexScopeService, { Config, type Config as Settings } from '../src/index.ts'
import type { CodexScopeClientId, CodexScopeSessionKey } from '../src/types.ts'
import type { CodexScopeSession } from '../src/state.ts'
import type { ExternalScopeProjection } from '@deepseek-ai/dsh-scope-access/receiving'

afterEach(cleanup)
const clientId = 'configured-codex-client' as CodexScopeClientId
const settings: Settings = { maxSessions: 16, maxProjections: 32, maxContextBytes: 4096 }

async function source(pool = new MemoryMediaPool(), overrides: Partial<Settings> = {}) {
  const h = await host('codex-source', pool)
  const fork = h.ctx.plugin(CodexScopeService, Object.assign({}, settings, overrides))
  await fork
  const service = h.ctx.codexScope
  const hook = (sessionId = 'root-session', event: 'UserPromptSubmit' | 'PostToolUse' = 'UserPromptSubmit', signal = new AbortController().signal) =>
    service.hook({ clientId, sessionId, cwd: process.cwd(), event }, signal)
  const observe = async (sessionId = 'root-session') => {
    await hook(sessionId)
    return (await service.sessions()).find(session => session.sessionId === sessionId)!
  }
  return { ...h, service, hook, observe, fork }
}

async function scenario(overrides: Partial<Settings> = {}) {
  const owner = await host('codex-owner')
  const recipient = await source(undefined, overrides)
  const task = await owner.createTask('API requires displayName')
  await owner.createTask('PRIVATE_UNRELATED_TASK')
  const invitation = await owner.access.invite({ taskId: task.id, recipientPeerId: peer('codex-source'),
    ownerAddress: (await owner.access.identity()).addresses[0]!, expiresAt: Date.now() + 50_000, responsibility: 'frontend' })
  const observed = await recipient.observe()
  const receive = () => recipient.service.receive({ sessionKey: observed.sessionKey,
    expectedReadRevision: observed.readRevision, invitation })
  return { owner, recipient, task, invitation, observed, receive }
}

function retained(pool: MemoryMediaPool) {
  return pool.media.get('codex_scope')!
}
function session(pool: MemoryMediaPool, key: CodexScopeSessionKey): CodexScopeSession {
  // The domain parser owns validation; tests inspect records after real durable writes.
  return retained(pool).tables.get('sessions')!.get(key) as CodexScopeSession
}

it('requires explicit positive limits and observes independent client/session pairs without receiving', async () => {
  expect(() => Config({} as Settings)).toThrow()
  expect(() => Config(Object.assign({}, settings, { maxContextBytes: 0 }))).toThrow()
  const h = await source()
  const changed = vi.fn()
  h.ctx.on('codex-scope/session-changed', changed)
  expect(await h.hook()).toEqual({ output: {} })
  expect(await h.hook('other-root', 'PostToolUse')).toEqual({ output: {} })
  await h.service.hook({ clientId: 'other-client' as CodexScopeClientId, sessionId: 'root-session',
    cwd: process.cwd(), event: 'UserPromptSubmit' }, new AbortController().signal)
  const observed = await h.service.sessions()
  expect(observed).toHaveLength(3)
  expect(new Set(observed.map(item => item.sessionKey)).size).toBe(3)
  expect(observed.every(item => item.readRevision === 0 && item.receiveSubscriptionId === undefined)).toBe(true)
  expect(changed).toHaveBeenCalledTimes(3)
  expect((await h.access.list()).subscriptions).toEqual([])
})

it('checks fresh real owner authority at every hook, persists exact output, and resends unchanged bytes', async () => {
  const f = await scenario()
  const selected = await f.receive()
  expect(selected.readRevision).toBe(1)
  expect(selected.receiveState).toBe('active')
  const read = vi.spyOn(f.recipient.access, 'retrieveWithinBudget')
  const first = await f.recipient.hook()
  const text = first.output.hookSpecificOutput!.additionalContext
  expect(text).toContain('API requires displayName')
  expect(text).not.toContain('PRIVATE_UNRELATED_TASK')
  expect(text).not.toContain('root-session')
  const current = session(f.recipient.pool, selected.sessionKey)
  expect(retained(f.recipient.pool).tables.get('projections')!.get(current.lastProjectionId!)).toMatchObject({ text })
  const again = await f.recipient.hook('root-session', 'PostToolUse')
  expect(again.output.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: text })
  expect(read).toHaveBeenCalledTimes(2)
  expect(retained(f.recipient.pool).tables.get('projections')!.size).toBe(1)
  expect(f.recipient.tasks.list({ limit: 16 })).toEqual([])
  expect(await f.recipient.hook('unjoined-root')).toEqual({ output: {} })
})

it.each(['unavailable', 'revoked', 'expired'] as const)('replaces current facts with a %s notice', async (state) => {
  const f = await scenario()
  await f.receive()
  await f.recipient.hook()
  if (state === 'unavailable') await f.owner.ctx.fiber.dispose()
  if (state === 'revoked') await f.owner.access.revoke({ grantId: f.invitation.grantId })
  if (state === 'expired') vi.spyOn(Date, 'now').mockReturnValue(f.invitation.expiresAt + 1)
  const notice = await f.recipient.hook()
  expect(notice.output.hookSpecificOutput!.additionalContext).not.toContain('API requires displayName')
  expect(notice.output.hookSpecificOutput!.additionalContext).toContain(`"status":"${state}"`)
  const summary = (await f.recipient.service.sessions())[0]!
  expect(summary.receiveState).toBe(state)
  expect(summary.receiveSubscriptionId === undefined).toBe(state !== 'unavailable')
  const repeat = await f.recipient.hook()
  expect(repeat).toEqual(notice)
})

it('persists the original plan before uncertain adoption and resumes it after restart without reallocating', async () => {
  const f = await scenario()
  const ensure = vi.spyOn(f.recipient.access, 'ensureSubscription').mockRejectedValueOnce(new Error('adoption reply lost'))
  await expect(f.receive()).rejects.toThrow('adoption reply lost')
  const original = session(f.recipient.pool, f.observed.sessionKey)
  expect(original.receive?.status).toBe('pending')
  expect(ensure.mock.calls[0]![0]).toEqual(original.receive!.plan)
  ensure.mockRestore()
  await f.recipient.observe('unjoined-root')
  await f.recipient.ctx.fiber.dispose()
  retained(f.recipient.pool).tables.get('sessions')!.set(original.sessionKey, { ...original,
    receive: { ...original.receive!, plan: { ...original.receive!.plan, routeRevision: 0 } } })
  const restarted = await source(f.recipient.pool)
  const output = await restarted.hook()
  expect(output.output.hookSpecificOutput!.additionalContext).toContain('API requires displayName')
  expect((await restarted.access.list()).subscriptions.map(item => item.id)).toEqual([original.receive!.plan.id])
  expect((await restarted.service.sessions())[0]!.sessionKey).toBe(f.observed.sessionKey)
  expect((await restarted.service.sessions())[0]!.readRevision).toBe(1)
})

it('retains stopped consent when subscription cleanup fails and finishes the same cleanup on the next hook', async () => {
  const f = await scenario()
  const selected = await f.receive()
  await f.recipient.hook()
  const leave = vi.spyOn(f.recipient.access, 'leave').mockRejectedValueOnce(new Error('cleanup unavailable'))
  await expect(f.recipient.service.receiveLeave({ sessionKey: selected.sessionKey, expectedReadRevision: 1 }))
    .rejects.toThrow('cleanup unavailable')
  expect((await f.recipient.service.sessions())[0]).toMatchObject({ receiveState: 'left', readRevision: 2 })
  expect((await f.recipient.service.sessions())[0]!.receiveSubscriptionId).toBeUndefined()
  const notice = await f.recipient.hook()
  expect(notice.output.hookSpecificOutput!.additionalContext).toContain('"status":"left"')
  expect(notice.output.hookSpecificOutput!.additionalContext).not.toContain('displayName')
  expect(leave).toHaveBeenCalledTimes(2)
  expect((await f.recipient.access.list()).subscriptions[0]!.state).toBe('left')
  await expect(f.recipient.service.receiveLeave({ sessionKey: selected.sessionKey, expectedReadRevision: 1 }))
    .rejects.toThrow('stale receiving selection')
  const replacement = await f.recipient.service.receive({ sessionKey: selected.sessionKey, expectedReadRevision: 2,
    invitation: f.invitation })
  expect(replacement.receiveSubscriptionId).not.toBe(selected.receiveSubscriptionId)
  expect(replacement.readRevision).toBe(3)
})

it('stops a delayed hook before its facts can commit and preserves a later receiving selection', async () => {
  const f = await scenario()
  const selected = await f.receive()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.recipient.transport.transform = async (result) => { entered.resolve(undefined); await release.promise; return result }
  const pending = f.recipient.hook()
  const assertion = expect(pending).rejects.toThrow('superseded')
  await entered.promise
  try {
    await f.recipient.service.receiveLeave({ sessionKey: selected.sessionKey, expectedReadRevision: 1 })
    expect(session(f.recipient.pool, selected.sessionKey).receive!.status).toBe('left')
    expect(retained(f.recipient.pool).tables.get('projections')?.size ?? 0).toBe(0)
  } finally { release.resolve(undefined) }
  await assertion
  f.recipient.transport.transform = undefined
  await f.recipient.service.receive({ sessionKey: selected.sessionKey, expectedReadRevision: 2, invitation: f.invitation })
  await expect(f.recipient.service.receiveLeave({ sessionKey: selected.sessionKey, expectedReadRevision: 1 }))
    .rejects.toThrow('stale receiving selection')
  expect((await f.recipient.hook()).output.hookSpecificOutput!.additionalContext).toContain('displayName')
})

it('leaves an original adoption that completes after stop intent without creating an orphan', async () => {
  const f = await scenario()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const originalEnsure = f.recipient.access.ensureSubscription.bind(f.recipient.access)
  vi.spyOn(f.recipient.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
    entered.resolve(undefined); await release.promise; return originalEnsure(plan)
  })
  const selecting = f.receive()
  await entered.promise
  const committed = Promise.withResolvers<undefined>()
  const stopListening = f.recipient.ctx.on('codex-scope/session-changed', () => {
    if (session(f.recipient.pool, f.observed.sessionKey).receive!.status === 'left') committed.resolve(undefined)
  })
  const stopped = f.recipient.service.receiveLeave({ sessionKey: f.observed.sessionKey, expectedReadRevision: 1 })
  await committed.promise
  stopListening()
  release.resolve(undefined)
  expect((await selecting).receiveState).toBe('left')
  expect((await stopped).readRevision).toBe(2)
  expect((await f.recipient.access.list()).subscriptions[0]!.state).toBe('left')
})

it('shares an in-flight original adoption with a hook and supersedes an older hook with a newer one', async () => {
  const f = await scenario()
  const adoption = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const ensure = f.recipient.access.ensureSubscription.bind(f.recipient.access)
  const adopting = vi.spyOn(f.recipient.access, 'ensureSubscription').mockImplementationOnce(async (plan) => {
    entered.resolve(undefined); await adoption.promise; return ensure(plan)
  })
  const selecting = f.receive()
  await entered.promise
  const waitingHook = f.recipient.hook()
  // A complete event-loop turn drains the hook's local promise work while adoption remains explicitly blocked.
  await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
  expect(adopting).toHaveBeenCalledTimes(1)
  adoption.resolve(undefined)
  await selecting
  await waitingHook
  const arrived = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let first = true
  f.recipient.transport.transform = async (result) => {
    if (first) { first = false; arrived.resolve(undefined); await release.promise }
    return result
  }
  const older = f.recipient.hook()
  const assertion = expect(older).rejects.toThrow('superseded')
  await arrived.promise
  try { expect((await f.recipient.hook()).output.hookSpecificOutput!.additionalContext).toContain('displayName') }
  finally { release.resolve(undefined) }
  await assertion
})

it('retains stopped consent after failed pending adoption without creating a subscription merely to leave', async () => {
  const f = await scenario()
  const entered = Promise.withResolvers<undefined>()
  const adoption = Promise.withResolvers<never>()
  vi.spyOn(f.recipient.access, 'ensureSubscription').mockImplementationOnce(() => { entered.resolve(undefined); return adoption.promise })
  const selecting = f.receive()
  const selectionFailed = expect(selecting).rejects.toThrow('adoption failed')
  await entered.promise
  const committed = Promise.withResolvers<undefined>()
  f.recipient.ctx.on('codex-scope/session-changed', () => {
    if (session(f.recipient.pool, f.observed.sessionKey).receive!.status === 'left') committed.resolve(undefined)
  })
  const stopped = f.recipient.service.receiveLeave({ sessionKey: f.observed.sessionKey, expectedReadRevision: 1 })
  await committed.promise
  await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
  adoption.reject(new Error('adoption failed'))
  await selectionFailed
  expect((await stopped).receiveState).toBe('left')
  expect((await f.recipient.access.list()).subscriptions).toEqual([])
})

it('does not notify or adopt when consent cannot be saved and never returns unpersisted context', async () => {
  const f = await scenario()
  const changed = vi.fn()
  f.recipient.ctx.on('codex-scope/session-changed', changed)
  const ensure = vi.spyOn(f.recipient.access, 'ensureSubscription')
  f.recipient.pool.failNextWrites = 1
  await expect(f.receive()).rejects.toThrow('injected write failure')
  expect(changed).not.toHaveBeenCalled()
  expect(ensure).not.toHaveBeenCalled()
  const selected = await f.receive()
  // Inject after observation so the exact projection write fails.
  const read = f.recipient.access.retrieveWithinBudget.bind(f.recipient.access)
  vi.spyOn(f.recipient.access, 'retrieveWithinBudget').mockImplementationOnce(async (...args) => {
    const result = await read(...args)
    f.recipient.pool.failNextWrites = 1
    return result
  })
  await expect(f.recipient.hook()).rejects.toThrow('injected write failure')
  expect(session(f.recipient.pool, selected.sessionKey).lastProjectionId).toBeUndefined()
  expect((await f.recipient.hook()).output.hookSpecificOutput!.additionalContext).toContain('displayName')
})

it('rejects capacity, framing, unknown sessions, wrong recipients, and stale selections explicitly', async () => {
  const f = await scenario({ maxSessions: 1, maxProjections: 1 })
  await expect(f.recipient.hook('extra')).rejects.toThrow('maxSessions')
  await expect(f.recipient.service.receiveLeave({ sessionKey: f.observed.sessionKey, expectedReadRevision: 0 })).rejects.toThrow('no receiving interval')
  await expect(f.recipient.service.receive({ ...f.observed, expectedReadRevision: 0,
    invitation: { ...f.invitation, recipientPeerId: peer('wrong-peer') } })).rejects.toThrow('not a current independent')
  await expect(f.recipient.service.receive({ sessionKey: 'missing' as CodexScopeSessionKey,
    expectedReadRevision: 0, invitation: f.invitation })).rejects.toThrow('unknown observed session')
  await f.receive()
  await expect(f.receive()).rejects.toThrow('stale receiving selection')
  await expect(f.recipient.service.receive({ sessionKey: f.observed.sessionKey, expectedReadRevision: 1, invitation: f.invitation }))
    .rejects.toThrow('leave the current')
  await f.recipient.hook()
  await f.owner.access.revoke({ grantId: f.invitation.grantId })
  await expect(f.recipient.hook()).rejects.toThrow('maxProjections')
  const tiny = await source(undefined, { maxContextBytes: 1 })
  const observed = await tiny.observe()
  await expect(tiny.service.receive({ sessionKey: observed.sessionKey, expectedReadRevision: 0, invitation: f.invitation }))
    .rejects.toThrow('framing exceeds')
})

it('forwards caller cancellation and quiesces readers before releasing storage', async () => {
  const f = await scenario()
  await f.receive()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.recipient.transport.transform = async (result) => { entered.resolve(undefined); await release.promise; return result }
  const controller = new AbortController()
  const pending = f.recipient.hook('root-session', 'PostToolUse', controller.signal)
  const assertion = expect(pending).rejects.toThrow('caller cancelled')
  await entered.promise
  controller.abort(new Error('caller cancelled'))
  const closing = f.recipient.fork.dispose()
  release.resolve(undefined)
  await assertion
  await closing
  await expect(f.recipient.service.sessions()).rejects.toThrow('service disposed')
  await expect(f.recipient.service.hook({ clientId, sessionId: '', cwd: 'relative', event: 'PostToolUse' }, new AbortController().signal))
    .rejects.toThrow()
})

it.each(['installation', 'session-key', 'projection-link', 'projection-key', 'projection-digest', 'predecessor'] as const)(
  'fails startup on an invalid durable %s association', async (corruption) => {
    const f = await scenario()
    await f.receive()
    await f.recipient.hook()
    await f.recipient.ctx.fiber.dispose()
    const records = retained(f.recipient.pool)
    const current = session(f.recipient.pool, f.observed.sessionKey)
    if (corruption === 'installation') records.global = { installationId: null }
    if (corruption === 'session-key') records.global = { installationId: randomUUID() }
    if (corruption === 'projection-link') records.tables.get('sessions')!.set(current.sessionKey,
      { ...current, lastProjectionId: `codex-projection-${'a'.repeat(64)}` })
    if (corruption === 'projection-key') {
      const table = records.tables.get('projections')!
      table.set('wrong-key', table.get(current.lastProjectionId!))
    }
    if (corruption === 'projection-digest') {
      const table = records.tables.get('projections')!
      const id = `codex-projection-${'b'.repeat(64)}`
      table.set(id, { ...table.get(current.lastProjectionId!) as object, projectionId: id })
      table.delete(current.lastProjectionId!)
      records.tables.get('sessions')!.set(current.sessionKey, { ...current, lastProjectionId: id })
    }
    if (corruption === 'predecessor') {
      const table = records.tables.get('projections')!
      const projection = table.get(current.lastProjectionId!) as ExternalScopeProjection
      const previousProjectionId = `codex-projection-${'a'.repeat(64)}`
      const id = `codex-projection-${createHash('sha256').update(JSON.stringify([projection.cacheKey, previousProjectionId])).digest('hex')}`
      table.set(id, { ...projection, projectionId: id, previousProjectionId })
      table.delete(current.lastProjectionId!)
      records.tables.get('sessions')!.set(current.sessionKey, { ...current, lastProjectionId: id })
    }
    await expect(source(f.recipient.pool)).rejects.toThrow()
  },
)

it('restores a valid superseding projection chain without reopening the stopped subscription', async () => {
  const f = await scenario()
  await f.receive()
  await f.recipient.hook()
  await f.recipient.service.receiveLeave({ sessionKey: f.observed.sessionKey, expectedReadRevision: 1 })
  const notice = await f.recipient.hook()
  await f.recipient.ctx.fiber.dispose()
  const restarted = await source(f.recipient.pool)
  expect(await restarted.hook()).toEqual(notice)
  expect((await restarted.access.list()).subscriptions[0]!.state).toBe('left')
})

it.each(['sessions', 'projections'] as const)('rejects a retention reduction below existing %s', async (limit) => {
  const f = await scenario()
  await f.receive()
  await f.recipient.hook()
  await f.recipient.observe('another-unjoined-root')
  await f.recipient.service.receiveLeave({ sessionKey: f.observed.sessionKey, expectedReadRevision: 1 })
  await f.recipient.hook()
  await f.recipient.ctx.fiber.dispose()
  await expect(source(f.recipient.pool, limit === 'sessions' ? { maxSessions: 1 } : { maxProjections: 1 }))
    .rejects.toThrow('retention is smaller')
})

it('rejects a restored mismatched subscription and a read revision that cannot advance safely', async () => {
  const f = await scenario()
  const selected = await f.receive()
  await f.recipient.ctx.fiber.dispose()
  const subscriptions = f.recipient.pool.media.get('scope_access')!.tables.get('subscriptions')!
  const original = subscriptions.get(selected.receiveSubscriptionId!) as object
  subscriptions.set(selected.receiveSubscriptionId!, { ...original, generation: randomUUID() })
  const restarted = await source(f.recipient.pool)
  await expect(restarted.service.receiveLeave({ sessionKey: selected.sessionKey, expectedReadRevision: 1 }))
    .rejects.toThrow('original subscription association changed')
  await restarted.ctx.fiber.dispose()
  const current = session(f.recipient.pool, selected.sessionKey)
  retained(f.recipient.pool).tables.get('sessions')!.set(selected.sessionKey, { ...current, readRevision: Number.MAX_SAFE_INTEGER })
  const exhausted = await source(f.recipient.pool)
  await expect(exhausted.service.receiveLeave({ sessionKey: selected.sessionKey, expectedReadRevision: Number.MAX_SAFE_INTEGER }))
    .rejects.toThrow('readRevision exhausted')
})

it('reports a failed durable open and releases the plugin without a domain handle', async () => {
  const h = await host('failed-codex-source')
  vi.spyOn(h.ctx.storageDomain, 'open').mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(h.ctx.plugin(CodexScopeService, settings)).rejects.toThrow('storage unavailable')
})
