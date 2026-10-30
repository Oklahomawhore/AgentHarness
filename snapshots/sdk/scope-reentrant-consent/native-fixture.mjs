/** Replacement consent survives a real cancellation observer while the old replay provider is hanging. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent')
const TaskContext = await load('@deepseek-ai/dsh-development-task-context')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')

/** Loader fixture identity. */
export const name = 'scope-reentrant-consent-snapshot'
/** The supported SDK profile supplies the real Agent, Task, permission, and persistence services. */
export const inject = ['agents', 'scopeAgentContext', 'developmentTasks', 'developmentRooms', 'sessions', 'sessionPersistence', 'llm']

const originalPolicy = { goal: 'Maintain the original local responsibility.', activationLimit: 4, maxStepsPerTurn: 2, minIntervalMs: 0 }
const replacementPolicy = { ...originalPolicy, goal: 'Complete the explicitly selected replacement responsibility.' }
const originalCanary = 'REENTRANT_ORIGINAL_LOCAL_FACT'
const replacementCanary = 'REENTRANT_REPLACEMENT_LOCAL_FACT'
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/** Wait for the replay provider's consumed hang entry, then replace the actual Task epoch exactly once. */
export function apply(ctx) {
  const lifetime = new AbortController()
  const pending = new Set()
  let agent
  let participantId
  let originalTask
  let replacementTask
  let target
  let originalBinding
  let requests = 0
  let activation
  let selection
  let finished = false
  const own = promise => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), error => {
      pending.delete(promise)
      ctx.logger.error(error)
      ctx.appExit(1)
    })
    return promise
  }
  ctx.effect(() => async () => {
    lifetime.abort(new Error('reentrant consent fixture disposed'))
    await Promise.allSettled([...pending])
    assert.ok(finished, 'the replacement automatic turn must complete before fixture disposal')
  })
  ctx.on('agent/pre-step', async ({ agent: current, turn, step }, next) => {
    if (agent === undefined) {
      agent = current
      assert.equal(turn, 1)
      assert.equal(step, 1)
      participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'reentrant-human', kind: 'human', displayName: 'Local owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing local Agent' })
      originalTask = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'reentrant-human',
        objective: 'Original local responsibility.', scope: 'Retain original permission until explicitly replaced.' })
      replacementTask = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'reentrant-human',
        objective: 'Replacement local responsibility.', scope: 'Use only the newly selected local Task facts.' })
      await ctx.developmentTasks.publishContext({ taskId: originalTask.id, participantId: 'reentrant-human', text: originalCanary })
      await ctx.developmentTasks.publishContext({ taskId: replacementTask.id, participantId: 'reentrant-human', text: replacementCanary })
      const checked = await ctx.developmentTasks.checkout({ taskId: originalTask.id, participantId, bindingId: 'reentrant-original-epoch' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
      assert.ok(epoch)
      target = { taskId: originalTask.id, taskBindingId: checked.assignment.bindingId,
        expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
      const receivingContext = ctx.isolate('developmentTaskContextAdmission')
      const unrelated = receivingContext.isolate('agents')
      await unrelated.plugin(AgentRegistry)
      await unrelated.plugin(TaskContext, { maxContextBytesPerStep: 12000 })
      const foreignAgents = unrelated.get('agents')
      const foreignAdmission = receivingContext.get('developmentTaskContextAdmission')
      assert.ok(foreignAgents)
      assert.ok(foreignAdmission)
      assert.equal(foreignAgents.get(agent.id), undefined)
      assert.equal(foreignAdmission.signalFor(agent), undefined)
      const receiving = receivingContext.get('scopeAgentContext')
      assert.ok(receiving)
      const before = agent.session.snapshotEvents()
      await assert.rejects(receiving.bindLocal({ agentId: agent.id, expectedBindingId: null,
        ...target, automatic: originalPolicy }), /local Task admission consumer is unavailable/)
      assert.deepEqual(agent.session.snapshotEvents(), before)
    }
    assert.equal(current, agent)
    return await next()
  }, { prepend: true })
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (current !== agent || status !== 'idle') return
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (end?.data.turn === 1 && activation === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      activation = own((async () => {
        const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null,
          ...target, automatic: originalPolicy })
        originalBinding = bound.binding.id
      })())
    } else if (end?.data.turn === 3) {
      assert.equal(requests, 3)
      assert.equal(end.data.reason.kind, 'completed')
      finished = true
    }
  })
  ctx.on('agent/cancel-requested', ({ agent: current, cause }) => {
    if (current !== agent || cause.kind !== 'hook' || selection !== undefined) return
    const assignment = ctx.developmentTasks.latestAssignment(participantId)
    const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.participantId === participantId
      && event.change.kind === 'task-bound')
    if (assignment?.taskId !== replacementTask.id || epoch === undefined) return
    selection = own(Promise.allSettled([ctx.scopeAgentContext.bindLocal({ agentId: agent.id,
      expectedBindingId: originalBinding, taskId: replacementTask.id, taskBindingId: assignment.bindingId,
      expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, automatic: replacementPolicy })]))
  }, { global: true })
  ctx.on('llm/stream', async function* (options, next) {
    requests++
    assert.ok(requests <= 3, 'only bootstrap and the two independently permitted automatic turns may dispatch')
    const currentRequest = requests
    const messages = structuredClone(options.messages)
    const text = messages.map(body).join('\n')
    const events = structuredClone(agent.session.snapshotEvents())
    const header = structuredClone(agent.session.header)
    assert.deepEqual(Session.create(agent.id, structuredClone(events), header).deriveMessages(), messages)
    const ordinary = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.equal(ordinary.length, 1, 'replacement consent needs no second user message or resume')
    if (currentRequest < 3) {
      assert.ok(text.includes(originalCanary))
      assert.ok(!text.includes(replacementCanary))
    }
    if (currentRequest === 2) {
      own(ctx.agents.withoutInitiator(async () => {
        await activation
        const ready = join(process.cwd(), '.dsh/reentrant-consent-stream-ready')
        const deadline = performance.now() + 10000
        while (!existsSync(ready)) {
          lifetime.signal.throwIfAborted()
          if (performance.now() >= deadline) throw new Error('replay provider did not consume its hanging automatic request')
          await setTimeout(10, undefined, { signal: lifetime.signal })
        }
        assert.equal(agent.status, 'running')
        assert.equal(requests, 2)
        await ctx.developmentTasks.checkout({ taskId: replacementTask.id, participantId, bindingId: 'reentrant-replacement-epoch' })
        assert.ok(selection, 'the public cancellation observer must renew permission for the new actual Task epoch')
        const result = await selection
        assert.equal(result[0].status, 'fulfilled')
        const replacementDeadline = performance.now() + 10000
        while (requests < 3) {
          lifetime.signal.throwIfAborted()
          const current = await ctx.scopeAgentContext.status({ agentId: agent.id })
          assert.equal(current.state.mode, 'enabled', 'old turn retirement must not pause replacement consent')
          if (performance.now() >= replacementDeadline) throw new Error('replacement consent did not dispatch its automatic request')
          await setTimeout(10, undefined, { signal: lifetime.signal })
        }
      }))
    } else if (currentRequest === 3) {
      assert.ok(text.includes(replacementCanary))
      assert.ok(!text.includes(originalCanary))
      const state = (await ctx.scopeAgentContext.status({ agentId: agent.id })).state
      assert.equal(state.mode, 'enabled')
      assert.equal(state.usedBudget, 2)
      assert.deepEqual(state.automatic, replacementPolicy)
      assert.equal(state.binding.target.taskId, replacementTask.id)
      const oldEnd = events.find(event => event.type === 'turn/end' && event.data.turn === 2)
      assert.equal(oldEnd.data.reason.kind, 'aborted')
      const renewed = events.find(event => event.type === 'scope-agent-context/state'
        && event.data.binding?.id === state.binding.id && event.data.mode === 'enabled')
      assert.ok(oldEnd.seq < renewed.seq, 'old activity retires before replacement consent commits')
      assert.deepEqual(events.filter(event => event.type === 'scope-agent-context/request')
        .map(event => [event.data.turn, event.data.step]), [[2, 1], [3, 1]])
      assert.equal(await ctx.sessions.flush(agent.session), true)
      const persisted = await ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const stored = await persisted.read()
        assert.deepEqual(stored.events, events)
        assert.deepEqual(Session.create(persisted.id, structuredClone(stored.events), persisted.header).deriveMessages(), messages)
      } finally { await persisted.close() }
    }
    yield* next()
  })
}
