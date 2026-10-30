import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, expect, it, vi } from 'vitest'
import { withJoinSession } from '../src/join-session.ts'
import { initialState } from '../src/state.ts'

const contexts: Context[] = []
const directories: string[] = []
const releases: (() => void)[] = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) } finally {
    vi.restoreAllMocks()
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  }
})

function context() {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function barrier() {
  const value = Promise.withResolvers<undefined>()
  releases.push(() => { value.resolve(undefined) })
  return value
}

async function liveFixture(durable = true) {
  const ctx = context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (durable) {
    const root = await mkdtemp(join(tmpdir(), 'scope-join-writer-'))
    directories.push(root)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  }
  let writer: SessionHandle | undefined
  if (durable) {
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementationOnce(async (...args) => {
      writer = await create(...args)
      return writer
    })
  }
  const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()),
    agentOptions: { provider: 'unused', model: 'unused' } })
  return { ctx, handle, session: handle.agent.session, writer }
}

it('requires a Session store before invoking a join operation', async () => {
  const ctx = context()
  const operation = vi.fn()
  await expect(withJoinSession(ctx, SessionId(randomUUID()), new AbortController().signal, operation))
    .rejects.toThrow('Session store is unavailable')
  expect(operation).not.toHaveBeenCalled()
})

it('requires persistence before opening a cold Session', async () => {
  const ctx = context()
  await ctx.plugin(SessionStore)
  const operation = vi.fn()
  await expect(withJoinSession(ctx, SessionId(randomUUID()), new AbortController().signal, operation))
    .rejects.toThrow('cold cancellation requires Session persistence')
  expect(operation).not.toHaveBeenCalled()
})

it('does not acknowledge a live join without a durability participant', async () => {
  const { ctx, handle, session } = await liveFixture(false)
  let acknowledged = false
  try {
    await expect(withJoinSession(ctx, session.id, new AbortController().signal, async (writer) => {
      expect(writer.live).toBe(true)
      await writer.flush()
      acknowledged = true
    })).rejects.toThrow('read adoption requires durable Session storage')
    expect(acknowledged).toBe(false)
    expect(ctx.sessions.get(session.id)).toBe(session)
  } finally { await handle.dispose() }
})

it.each([false, true])('rejects an old live writer after detach during flush; replaced=%s', async (replace) => {
  const { ctx, handle, session, writer: durable } = await liveFixture()
  if (durable === undefined) throw new Error('fixture must own the actual JSONL writer')
  const persisted = barrier(), entered = barrier(), release = barrier()
  const flush = durable.flush.bind(durable)
  vi.spyOn(durable, 'flush').mockImplementationOnce(async (...args) => {
    await flush(...args)
    persisted.resolve(undefined)
  })
  let held = false, acknowledged = false
  const remove = ctx.on('session/flush', async (current) => {
    if (current !== session || held) return
    held = true
    await persisted.promise
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  let detach: (() => void) | undefined
  const writing = withJoinSession(ctx, session.id, new AbortController().signal, async (writer) => {
    writer.session.append('scope-agent-context/state', initialState(session.id))
    await writer.flush()
    acknowledged = true
  })
  const settled = Promise.allSettled([writing])
  try {
    await entered.promise
    await handle.dispose()
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    const replacement = replace ? ctx.sessions.prepare(session.id) : undefined
    if (replacement !== undefined) detach = ctx.sessions.enter(replacement)
    release.resolve(undefined)
    await expect(writing).rejects.toThrow('Session detached during read adoption')
    expect(acknowledged).toBe(false)
    expect(ctx.sessions.get(session.id)).toBe(replacement)
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try { expect((await reader.read()).events.some(event => event.type === 'scope-agent-context/state')).toBe(true) }
    finally { await reader.close() }
  } finally { release.resolve(undefined); await settled; remove(); detach?.(); await handle.dispose() }
})

it('does not acknowledge a live join after its lifetime ends during the real durability flush', async () => {
  const { ctx, handle, session } = await liveFixture()
  const lifetime = new AbortController()
  const entered = barrier(), release = barrier()
  let held = false, acknowledged = false
  const remove = ctx.on('session/flush', async (current) => {
    if (current !== session || held) return
    held = true
    entered.resolve(undefined)
    await release.promise
  }, { global: true })
  const writing = withJoinSession(ctx, session.id, lifetime.signal, async (writer) => {
    await writer.flush()
    acknowledged = true
  })
  const settled = Promise.allSettled([writing])
  try {
    await entered.promise
    lifetime.abort(new Error('join owner ended'))
    release.resolve(undefined)
    await expect(writing).rejects.toThrow('join owner ended')
    expect(acknowledged).toBe(false)
    expect(ctx.sessions.get(session.id)).toBe(session)
  } finally { release.resolve(undefined); await settled; remove(); await handle.dispose() }
})

it('releases its cold writer when the same Session becomes live during the real storage read', async () => {
  const ctx = context()
  await ctx.plugin(SessionStore)
  const root = await mkdtemp(join(tmpdir(), 'scope-join-cold-read-'))
  directories.push(root)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const original = Session.create(SessionId(randomUUID()))
  const stored = await ctx.sessionPersistence.create(original.header)
  try { await stored.flush() } finally { await stored.close() }
  const entered = barrier(), release = barrier()
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  const opening = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args)
    const read = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs) => {
      const result = await read(...readArgs)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    return handle
  })
  const operation = vi.fn()
  const writing = withJoinSession(ctx, original.id, new AbortController().signal, operation)
  const settled = Promise.allSettled([writing])
  let detach: (() => void) | undefined
  try {
    await entered.promise
    const replacement = ctx.sessions.prepare(original.id)
    detach = ctx.sessions.enter(replacement)
    release.resolve(undefined)
    await expect(writing).rejects.toThrow('Session became live during cold cancellation')
    expect(operation).not.toHaveBeenCalled()
    expect(ctx.sessions.get(original.id)).toBe(replacement)
    const reopened = await open(original.id, 'write')
    try { expect((await reopened.read()).events).toEqual([]) } finally { await reopened.close() }
  } finally { release.resolve(undefined); await settled; detach?.(); opening.mockRestore() }
})
