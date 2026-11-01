/** A real Scope unload blocks admission without consuming the original ordinary input. */
import assert from 'node:assert/strict'

/** Loader fixture identity. */
export const name = 'scope-unload-claim-snapshot'
/** The observer remains installed when the independent Scope consumer unloads. */
export const inject = ['agents', 'loader', 'llm', 'scopeTransport', 'sessionProjections']

/** Verify actual model requests after a public Loader unload and explicit SDK continuation. */
export async function apply(ctx) {
  await new Promise((resolve) => {
    const ready = () => {
      if (ctx.get('scopeAgentContext') === undefined) return
      stop()
      resolve()
    }
    const stop = ctx.on('internal/service', name => { if (name === 'scopeAgentContext') ready() })
    ready()
  })
  let original
  let activeAgent
  let turn = 0
  let requests = 0
  let retained = false
  ctx.on('agent/pre-step', async (payload, next) => {
    activeAgent = payload.agent
    turn = payload.turn
    if (turn !== 1) return await next()
    assert.equal(payload.step, 1)
    const users = payload.messages.filter(message => message.source.kind === 'user')
    assert.equal(users.length, 1)
    original = users[0]
    const receiving = ctx.get('scopeAgentContext')
    assert.ok(receiving)
    const beforeResume = activeAgent.session.snapshotEvents()
    const expectedBindingId = 'b4206cd6-e236-4014-9225-08cfed419639'
    await assert.rejects(receiving.resume({ agentId: activeAgent.id, expectedBindingId,
      automatic: { goal: 'Continue the existing local responsibility', activationLimit: 1, maxStepsPerTurn: 1, minIntervalMs: 0 } }),
    { code: 'scope-agent/stale-binding', details: { agentId: activeAgent.id, expectedBindingId, actualBindingId: null } })
    assert.deepEqual(activeAgent.session.snapshotEvents(), beforeResume)
    assert.equal((await receiving.status({ agentId: activeAgent.id })).state.mode, 'left')
    const decision = await next()
    const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-scope-agent-context')
    assert.equal(entries.length, 1)
    await entries[0].update({ disabled: true })
    assert.equal(ctx.get('scopeAgentContext'), undefined)
    assert.equal(ctx.sessionProjections.stateOf(activeAgent.session, 'scopeAgentContext'), undefined)
    assert.equal(ctx.agents.get(activeAgent.id), activeAgent)
    assert.equal(payload.signal.aborted, false)
    return decision
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== activeAgent || status !== 'idle') return
    const ended = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ended?.data.turn !== 1) return
    assert.equal(ended.data.reason.kind, 'blocked')
    assert.equal(requests, 0)
    assert.deepEqual(agent.inbox.nextTurn, [original])
    assert.deepEqual(agent.inbox.nextStep, [])
    retained = true
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.equal(retained, true)
    assert.equal(turn, requests + 1)
    assert.ok(requests <= 2)
    assert.equal(ctx.get('scopeAgentContext'), undefined)
    assert.equal(ctx.scopeTransport.reads, 0)
    assert.equal(activeAgent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/request'), false)
    assert.equal(options.messages.some(message => message.source.kind === 'scope-agent-context'), false)
    const users = options.messages.filter(message => message.role === 'user' && message.source.kind === 'user')
    assert.equal(users.filter(message => message.id === original.id).length, 1)
    assert.equal(users.length, requests)
    if (requests === 2) assert.deepEqual(users[1].content,
      [{ type: 'text', text: 'Continue the retained ordinary request explicitly.' }])
    return next()
  })
}
