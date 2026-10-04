/** Existing owner Agent reacts to a peer's real file work using bounded local automatic permission. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-owner-idle-snapshot'
/** The supported profile supplies the actual receiving, capture and loop services. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm']
const contexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
async function until(label, predicate) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`owner idle fixture did not observe ${label}`)
    await setTimeout(10)
  }
}
/** Only model replies and peer delivery are controlled; actual file tools create source publications. */
export async function apply(ctx) {
  const source = await host(join(process.cwd(), '.dsh/idle-peer'), 'source')
  ctx.effect(() => source.close)
  const peer = (await source.ctx.agents.create({ sessionId: 'owner-idle-peer',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: source.workspace } })).agent
  const ownerRoot = join(process.cwd(), '.dsh/idle-owner')
  await mkdir(ownerRoot, { recursive: true })
  let owner
  let task
  let target
  let bindingId
  let requests = 0
  let stage = 'setup'
  let trigger
  const pending = new Set()
  const own = promise => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), error => { pending.delete(promise); ctx.logger.error(error); ctx.appExit(1) })
  }
  ctx.effect(() => async () => { await Promise.allSettled([...pending]) })
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    owner = agent
    if (turn === 1 && step === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'idle-human', kind: 'human', displayName: 'Owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing owner Agent' })
      task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'idle-human',
        objective: 'Maintain a shared implementation.', scope: 'Use authorized peer reports to update the owner result.' })
      await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: 'idle-owner-binding' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
      target = { taskId: task.id, taskBindingId: 'idle-owner-binding', expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
      const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
      await ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, taskId: task.id,
        bindingId: target.taskBindingId, expectedBindingEpoch: target.expectedBindingEpoch, roots: [ownerRoot], tools: ['write'], limits })
      await until('local capture', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
      const ownerAddress = (await ctx.scopeAccess.identity()).addresses[0]
      const entry = await ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
        ownerAddress, expiresAt: limits.expiresAt })
      const proposal = await source.ctx.scopeAgentContributions.request({ agentId: peer.id, expectedCapture: null,
        entry: entry.entry, roots: [source.workspace], tools: ['write'], limits })
      await until('peer application', async () => (await ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status === 'pending')
      await ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
        expectedProposal: proposal.capture.proposal, limits, ownerAddress })
      await until('peer capture', async () => (await source.ctx.scopeAgentContributions.status({ agentId: peer.id })).capture?.collecting)
      const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target,
        automatic: { goal: 'Update the owner result when peer work changes.', activationLimit: 1, maxStepsPerTurn: 2, minIntervalMs: 0 } })
      bindingId = bound.binding.id
      trigger = async () => {
        const call = { type: 'tool-call', id: 'idle-peer-write', name: 'write',
          arguments: JSON.stringify({ file_path: 'peer.txt', content: 'PEER_AUTOMATIC_TRIGGER\n' }) }
        source.adapter.script.push([{ type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'block-end', index: 0, block: call }, { type: 'finish', reason: { kind: 'tool-calls' } }], reply('Peer finished.'))
        peer.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the peer implementation.' }], source: { kind: 'user' } }))
        await peer.whenIdle()
        assert.equal(await readFile(join(source.workspace, 'peer.txt'), 'utf8'), 'PEER_AUTOMATIC_TRIGGER\n')
        await until('peer durable publication', () => ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.peerToolObservation !== undefined))
      }
      stage = 'first'
    } else if (turn === 2 && step === 2) {
      await until('owner durable publication', () => ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.localToolObservation !== undefined))
      assert.equal(await readFile(join(ownerRoot, 'owner.txt'), 'utf8'), 'OWNER_AUTOMATIC_RESULT\n')
    } else if (turn === 3 && step === 1) {
      const evidence = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')
      const last = agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/request')
      assert.equal(last.data.turn, 2)
      assert.equal(last.data.step, 2)
      assert.equal(evidence.completed.requestSeq, last.seq)
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture.collecting, true)
      await ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: bindingId, ...target })
      await until('local source ended', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture === null)
      assert.equal(ctx.developmentTasks.assignmentList().length, 0)
      assert.equal((await source.ctx.scopeAgentContributions.status({ agentId: peer.id })).capture.collecting, true)
    }
    return next()
  }, { prepend: true })
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== owner || status !== 'idle' || stage !== 'first') return
    stage = 'triggered'
    own(trigger())
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 4)
    const visible = contexts(options.messages)
    assert.equal(visible.length, 1)
    const text = body(visible[0])
    if (requests === 4) {
      assert.equal(visible[0].source.form, 'disconnected')
      assert.ok(!text.includes('PEER_AUTOMATIC_TRIGGER'))
      const status = ctx.sessionProjections.stateOf(owner.session, 'scopeAgentContext')
      assert.equal(status.usedBudget, 1)
      assert.equal(status.mode, 'left')
    } else {
      assert.equal(visible[0].source.version, 3)
      assert.equal(visible[0].source.projection.taskId, task.id)
      assert.equal(text.includes('PEER_AUTOMATIC_TRIGGER'), requests > 1)
      assert.ok(!text.includes('OWNER_AUTOMATIC_RESULT'))
    }
    assert.equal(options.messages.filter(message => message.source.kind === 'scope-agent-context' && message.source.form === 'snapshot').length, 0)
    const events = JSON.parse(JSON.stringify(owner.session.snapshotEvents()))
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, requests === 4 ? 2 : 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse').length, requests === 1 ? 0 : 1)
    assert.deepEqual(contexts(Session.create(owner.id, events, owner.session.header).deriveMessages()), visible)
    return next()
  })
}
