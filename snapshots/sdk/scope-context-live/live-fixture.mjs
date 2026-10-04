/** Assert actual native requests after passive adoption, idle activation, busy replacement, and leave. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { invitation } from './transport-fixture.mjs'

const packageRequire = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const baseRequire = createRequire(new URL('../../../packages/bundle/base/package.json', import.meta.url))
const { Session } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-session')).href)
const { defineContentToolFixture } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-tools')).href)

/** Loader fixture identity. */
export const name = 'scope-context-live-snapshot'
/** All requests pass through these real profile services. */
export const inject = ['agents', 'scopeAgentContext', 'scopeTransport', 'scopeAccess', 'developmentTasks', 'llm', 'tools']

const scopeMessages = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const content = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/** Observe requests and control only external owner changes and explicit local permission. */
export function apply(ctx) {
  let agent
  let requests = 0
  let toolCalls = 0
  let resumed = false
  let rechecking = false
  let started = false
  let bindingId
  const pending = new Set()
  const own = promise => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), error => { pending.delete(promise); ctx.logger.error(error); ctx.appExit(1) })
  }
  ctx.effect(() => async () => { await Promise.allSettled([...pending]) })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'scope_fixture_change', description: 'Advance the controlled remote API declaration for this snapshot.', parameters: {},
    async execute() {
      assert.equal(requests, 2)
      assert.equal(agent.status, 'running')
      toolCalls++
      ctx.scopeTransport.change(3)
      return [{ type: 'text', text: 'Remote declaration advanced during the active turn.' }]
    },
  })))
  ctx.on('agent/pre-step', async ({ agent: current, turn, step }, next) => {
    agent = current
    if (!started) {
      assert.equal(turn, 1)
      started = true
      const bound = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
      bindingId = bound.binding.id
    }
    if (turn === 3 && step === 1) await ctx.scopeAgentContext.leave({ agentId: agent.id, expectedBindingId: bindingId })
    return await next()
  })
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (current !== agent || status !== 'idle') return
    if (requests === 3 && !rechecking) {
      rechecking = true
      ctx.scopeTransport.change(4)
      return
    }
    if (requests !== 1 || resumed) return
    resumed = true
    ctx.scopeTransport.change(2)
    own(ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: bindingId, automatic: {
      goal: 'Update the client against the current orders API declaration.', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0,
    } }))
  })
  ctx.on('session/event', (session, event) => {
    if (session !== agent?.session || event.type !== 'scope-agent-context/evaluation'
      || event.data.decision !== 'suppress-unchanged') return
    assert.equal(requests, 3, 'completed automatic work, not the earlier user turn, suppresses repeated evidence')
    assert.ok(event.data.baseline)
    const states = agent.session.snapshotEvents().filter(item => item.type === 'scope-agent-context/state')
    assert.equal(states.at(-1).data.mode, 'enabled')
    assert.equal(states.at(-1).data.usedBudget, 1)
    if (event.data.projection.taskRevision === 4) ctx.scopeTransport.change(5)
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 4)
    assert.ok(agent)
    const visible = scopeMessages(options.messages)
    assert.equal(visible.length, 1)
    const declarations = ['orderCode is required.', 'sku is required.', 'itemId is required.']
    const expected = declarations[requests - 1]
    const text = options.messages.map(content).join('\n')
    if (requests < 4) {
      assert.equal(visible[0].source.projection.taskRevision, requests)
      assert.ok(content(visible[0]).includes(expected))
    } else {
      assert.equal(visible[0].source.form, 'withdrawn')
      assert.equal(visible[0].source.reason, 'left')
      assert.ok(content(visible[0]).includes('No current shared scope facts'))
      assert.equal(toolCalls, 1)
      assert.ok(ctx.scopeTransport.reads >= 4)
      const suppressed = agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/evaluation'
        && event.data.decision === 'suppress-unchanged')
      assert.deepEqual(suppressed.map(event => event.data.projection.taskRevision), [4, 5])
    }
    for (const stale of declarations.slice(0, requests - 1)) assert.ok(!text.includes(stale))
    const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
    if (requests === 4) {
      const suppressed = events.filter(event => event.type === 'scope-agent-context/evaluation' && event.data.decision === 'suppress-unchanged')
      for (const evaluation of suppressed) {
        const dispatched = events.find(event => event.seq === evaluation.data.baseline.requestSeq)
        assert.equal(dispatched.type, 'scope-agent-context/request')
        assert.equal(dispatched.data.turn, 2)
        assert.equal(dispatched.data.step, 2, 'the completed baseline follows the last busy request, not the idle prefetch')
        assert.equal(dispatched.data.projection.taskRevision, 3)
        const context = events.find(event => event.seq === dispatched.data.contextSeq)
        assert.equal(context.type, 'user/message')
        assert.equal(context.data.source.projection.projectionId, dispatched.data.projection.projectionId)
        const ended = events.find(event => event.seq === evaluation.data.baseline.turnEndSeq)
        assert.equal(ended.type, 'turn/end')
        assert.deepEqual(ended.data.reason, { kind: 'completed' })
        assert.equal(ended.data.turn, 2)
      }
    }
    const users = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.equal(users.length, requests < 4 ? 1 : 2, 'the idle turn and busy step use no synthetic user input')
    const pulses = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')
    assert.equal(pulses.length, requests === 1 ? 0 : 1)
    const states = events.filter(event => event.type === 'scope-agent-context/state')
    assert.equal(states.at(-1).data.usedBudget, requests === 1 ? 0 : 1)
    const history = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')
    assert.equal(history.length, requests)
    assert.ok(content(history[0].data).includes('orderCode'), 'prior facts remain durable history')
    const replay = Session.create(agent.id, events, agent.session.header)
    assert.deepEqual(scopeMessages(replay.deriveMessages()), visible, 'detached Session replay matches the actual current request')
    assert.deepEqual(ctx.developmentTasks.list({ limit: 32 }), [], 'receipt creates no local Task replica or assignment')
    assert.deepEqual(ctx.developmentTasks.assignmentList(), [])
    return next()
  })
}
