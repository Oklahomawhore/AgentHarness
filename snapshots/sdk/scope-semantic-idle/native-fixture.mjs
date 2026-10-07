/** Semantic evidence suppresses repeated unrelated writes while bounded native responses retain exact provenance. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../../packages/collaboration/development-task-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
const { peerContributionPayloadDigest } = await load('@deepseek-ai/dsh-development-task')

/** Loader fixture identity. */
export const name = 'scope-semantic-idle-snapshot'
/** Actual Task, scheduler, loop and isolated auxiliary audit services. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'scopeAgentContext', 'scopeAccess',
  'sessionProjections', 'llm', 'sessionPersistence']

const auditId = 'scope-semantic-idle-audit'
const ownerPeerId = '12D3KooWCMEyhAgjMNJghrqKxvCpLipFmnepRNXXPBxVrz1VBXVe'
const contributorPeerId = '12D3KooWFCgiTqWhtsJ1Zj49VtnbFN7F3t1NoMhpZHZnQiF5mr3E'
const content = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const digest = value => createHash('sha256').update(value).digest('hex')
const activityIdentity = value => ({ bindingId: value.bindingId, goalDigest: value.goalDigest,
  taskRevision: value.projection.taskRevision, projectionId: value.projection.projectionId })
const activityRequest = event => ({ ...activityIdentity(event.data), activationId: event.data.activationId,
  requestSeq: event.seq, contextSeq: event.data.contextSeq, turn: event.data.turn, step: event.data.step })
const noActivity = { request: null, completed: null, evaluation: null }
const reports = [
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/retry.ts', content: 'export const retryPolicy = "RETRY_LIMIT_3";\n' } },
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'admin/catering.txt', content: 'UNRELATED_ADMIN: office catering inventory changed.\n' } },
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'admin/catering.txt', content: 'UNRELATED_ADMIN: office catering inventory corrected again.\n' } },
  { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/retry.ts', oldString: 'RETRY_LIMIT_3', newString: 'RETRY_LIMIT_1', replaceAll: false } },
  { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'failure', omissions: ['oldString', 'newString'],
    fields: { rootIndex: 0, path: 'src/retry.ts', error: 'FAILED_RETRY_9: target not found', replaceAll: false } },
]
const summaries = [
  { marker: 'RETRY_LIMIT_1', text: 'A successful Edit reports correcting the retry policy to RETRY_LIMIT_1.' },
  { marker: 'FAILED_RETRY_9', text: 'The later Edit failed (FAILED_RETRY_9); it does not establish another successful change.' },
  { marker: 'RETRY_LIMIT_3', text: 'The earlier successful Write reported RETRY_LIMIT_3.' },
]

class ControlledSummaryAdapter extends LlmAdapter {
  constructor(readAudit) { super(); this.readAudit = readAudit; this.requests = [] }
  async * stream(options) {
    assert.equal(options.purpose, 'context-summary')
    assert.equal(options.sessionId, auditId)
    assert.deepEqual(options.tools ?? [], [])
    this.requests.push(options)
    assert.ok(this.requests.length <= 5)
    const requests = (await this.readAudit()).filter(event => event.type === 'context/semantic-request')
    assert.equal(requests.length, this.requests.length, 'the real auxiliary request must be flushed before dispatch')
    assert.deepEqual(requests.at(-1).data.messages, options.messages)
    assert.equal(requests.at(-1).data.system, options.system)
    assert.equal(requests.at(-1).data.call.maxTokens, options.maxTokens)
    const input = JSON.parse(content(options.messages[0]))
    assert.equal(input.recipient.sessionLabel, 'Maintain the retry implementation')
    const decisions = []
    const updates = []
    for (const source of input.sources) {
      const summary = summaries.find(value => source.body.includes(value.marker))
      decisions.push({ sourceId: source.sourceId, relevant: summary !== undefined })
      if (summary === undefined) assert.ok(source.body.includes('UNRELATED_ADMIN'))
      else updates.push({ text: summary.text, sources: [{ sourceId: source.sourceId, quote: summary.marker }] })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ version: 1, decisions, updates }) }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 80 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Admit attributed reports through Task authority and inspect actual automatic model requests.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped SDK composition with separate auxiliary persistence.
 */
export async function apply(ctx) {
  const readAudit = async () => {
    await using handle = await ctx.sessionPersistence.open(auditId, 'read')
    return (await handle.read()).events
  }
  const adapter = new ControlledSummaryAdapter(readAudit)
  ctx.effect(() => ctx.llm.registerAdapter(['semantic-idle-snapshot'], adapter))
  let agent
  let task
  let target
  let bindingId
  let grant
  let requests = 0
  let stage = 'setup'
  const suppressed = []
  const admitted = []
  const pending = new Set()
  const own = promise => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), error => {
      pending.delete(promise); ctx.logger.error(error); ctx.appExit(1)
    })
  }
  ctx.effect(() => async () => { await Promise.allSettled([...pending]) })
  const state = () => ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
  const admit = async index => {
    const request = { grant, sourceId: digest(`semantic-idle/${index + 1}`), sequence: index + 1, result: reports[index] }
    const result = await ctx.developmentTasks.admitPeerContribution(request, contributorPeerId)
    assert.equal(result.outcome, 'published')
    assert.equal(result.receipt.payloadDigest, peerContributionPayloadDigest(request))
    admitted[index] = result.publication
  }
  const activity = async () => {
    const status = await ctx.scopeAgentContext.status({ agentId: agent.id })
    assert.equal(status.eligibility, 'eligible')
    assert.equal(status.state.binding?.id ?? null, state().binding?.id ?? null)
    return status.activity
  }
  const completed = async turn => {
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    assert.equal(end.data.turn, turn)
    assert.equal(end.data.reason.kind, 'completed')
    const observed = await activity()
    assert.equal(observed.request, null)
    if (turn === 1) assert.deepEqual(observed, noActivity)
    else {
      const evidence = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence').completed
      assert.equal(evidence.turnEndSeq, end.seq)
      const request = agent.session.eventAt(evidence.requestSeq)
      assert.equal(request.type, 'scope-agent-context/request')
      assert.deepEqual(observed.completed, { ...activityRequest(request),
        assistantSeq: evidence.assistantSeq, turnEndSeq: end.seq })
    }
  }
  ctx.on('agent/pre-step', async ({ agent: current, turn, step }, next) => {
    agent = current
    assert.equal(step, 1)
    assert.ok(turn <= 6)
    if (turn === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'semantic-idle-owner', kind: 'human', displayName: 'Independent task owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing implementation Agent' })
      task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'semantic-idle-owner',
        objective: 'Keep independently owned implementation work informed by authorized reports.',
        scope: 'Reports do not grant tool permissions or authority over another participant.' })
      await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: 'semantic-idle-task-binding',
        sessionLabel: 'Maintain the retry implementation' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
      target = { taskId: task.id, taskBindingId: 'semantic-idle-task-binding', expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
      grant = { version: 1, taskId: task.id, grantId: 'semantic-idle-grant', generation: 'semantic-idle-grant-generation',
        ownerPeerId, contributorPeerId, captureId: 'semantic-idle-capture', captureGeneration: 'semantic-idle-capture-generation',
        source: { kind: 'tool-observations', name: 'session-work', tools: ['Edit', 'Write'] },
        expiresAt: Date.now() + 50000, maxSamples: 5, maxSampleBytes: 4096 }
      await ctx.developmentTasks.openPeerContribution(grant)
      const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target,
        automatic: { goal: 'Review relevant retry implementation reports within my existing permissions.',
          activationLimit: 4, maxStepsPerTurn: 1, minIntervalMs: 0 } })
      bindingId = bound.binding.id
      stage = 'initial'
    } else if (turn === 6) {
      await completed(5)
      assert.equal(stage, 'withdrawn')
      assert.equal(requests, 5)
      assert.equal(suppressed.length, 2)
      assert.equal(state().binding.id, bindingId)
      assert.equal(state().usedBudget, 4)
      assert.equal(state().automatic.activationLimit, 4)
      const events = agent.session.snapshotEvents()
      assert.equal(events.filter(event => event.type === 'scope-agent-context/evaluation' && event.data.decision === 'activate').length, 4)
      assert.equal(events.filter(event => event.type === 'scope-agent-context/request').length, 4)
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse').length, 4)
      const audit = await readAudit()
      const auxiliaryRequests = audit.filter(event => event.type === 'context/semantic-request')
      const results = audit.filter(event => event.type === 'context/semantic-result')
      assert.equal(auxiliaryRequests.length, 5)
      assert.equal(results.length, 5)
      assert.ok(results.every(event => event.data.version === 4 && event.data.status === 'completed'))
      for (const result of results) {
        const request = auxiliaryRequests.find(value => value.seq === result.data.requestSeq)
        assert.equal(result.data.key, request.data.key)
      }
      await ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: bindingId, ...target })
      assert.equal(ctx.developmentTasks.assignmentList().length, 0)
      assert.deepEqual(await activity(), noActivity)
      assert.equal(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence').completed.request.turn, 5)
      stage = 'left'
    }
    return next()
  }, { prepend: true })
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (current !== agent || status !== 'idle') return
    if (stage === 'initial') {
      stage = 'first-report'
      own((async () => { await completed(1); await admit(0) })())
    } else if (stage === 'first-report') {
      stage = 'unrelated'
      own((async () => { await completed(2); assert.equal(state().usedBudget, 1); await admit(1) })())
    } else if (stage === 'corrected') {
      stage = 'failed'
      own((async () => { await completed(3); await admit(4) })())
    } else if (stage === 'failed') {
      stage = 'withdrawn'
      own((async () => {
        await completed(4)
        const ended = await ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, ownerPeerId)
        assert.equal(ended.event.kind, 'peer-contribution-ended')
      })())
    }
  })
  ctx.on('session/event', (session, event) => {
    if (session !== agent?.session || event.type !== 'scope-agent-context/evaluation'
      || event.data.decision !== 'suppress-unchanged' || !['unrelated', 'unrelated-overwrite'].includes(stage)) return
    const overwritten = stage === 'unrelated-overwrite'
    stage = 'checking-suppression'
    own((async () => {
      assert.equal(requests, 2)
      assert.equal(state().usedBudget, 1)
      assert.equal(state().binding.id, bindingId)
      const baseline = agent.session.eventAt(event.data.baseline.requestSeq)
      assert.equal(baseline.type, 'scope-agent-context/request')
      assert.equal(baseline.data.turn, 2)
      assert.equal(baseline.data.step, 1)
      const projection = event.data.projection
      assert.equal(projection.activation.kind, 'recipient-evidence')
      assert.deepEqual(projection.activation, baseline.data.projection.activation)
      assert.notEqual(projection.projectionId, baseline.data.projection.projectionId)
      assert.ok(projection.taskRevision > baseline.data.projection.taskRevision)
      assert.ok(projection.omittedSources.some(value => value.reason === 'recipient-irrelevant'
        && value.source.publicationId === admitted[overwritten ? 2 : 1].id))
      if (overwritten) {
        assert.ok(projection.omittedSources.some(value => value.reason === 'superseded'
          && value.source.publicationId === admitted[1].id))
        assert.notEqual(projection.projectionId, suppressed[0].data.projection.projectionId)
        assert.ok(projection.taskRevision > suppressed[0].data.projection.taskRevision)
      }
      assert.ok(!projection.text.includes('UNRELATED_ADMIN'))
      assert.equal(adapter.requests.length, overwritten ? 3 : 2)
      const observed = await activity()
      assert.equal(observed.request, null)
      assert.deepEqual(observed.evaluation, { ...activityIdentity(event.data),
        decision: 'suppress-unchanged', activationId: null })
      assert.equal(observed.completed.requestSeq, baseline.seq)
      assert.equal(observed.completed.turnEndSeq, event.data.baseline.turnEndSeq)
      assert.equal(observed.completed.taskRevision, baseline.data.projection.taskRevision)
      suppressed.push(event)
      stage = overwritten ? 'corrected' : 'unrelated-overwrite'
      await admit(overwritten ? 3 : 2)
    })())
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose === 'context-summary') return yield* next()
    requests++
    assert.ok(requests <= 6)
    assert.equal(adapter.requests.length, [0, 1, 4, 5, 5, 5][requests - 1])
    const visible = contexts(options.messages)
    assert.equal(visible.length, 1)
    const message = visible[0]
    const text = content(message)
    assert.ok(!JSON.stringify(options.messages).includes('UNRELATED_ADMIN'))
    assert.ok(!options.messages.some(value => value.source.kind === 'scope-agent-context'))
    if (requests === 6) {
      assert.equal(stage, 'left')
      assert.equal(message.source.form, 'disconnected')
      assert.equal(state().mode, 'left')
      assert.equal(state().usedBudget, 4)
    } else {
      assert.equal(message.source.version, 3)
      const projection = message.source.projection
      assert.equal(projection.backend.id, 'semantic')
      assert.equal(projection.activation.kind, 'recipient-evidence')
      assert.equal(projection.taskId, task.id)
      assert.equal(projection.text, text)
      const body = JSON.parse(text.split('<shared-work-updates>\n')[1].split('\n</shared-work-updates>')[0])
      assert.equal(body.updates.length, [0, 1, 2, 3, 0][requests - 1])
      if (requests === 3) assert.ok(text.includes('RETRY_LIMIT_1'))
      if (requests === 4) assert.ok(text.includes('FAILED_RETRY_9'))
      if (requests === 5) {
        assert.equal(body.mandatory.length, 1)
        assert.equal(body.mandatory[0].kind, 'withdrawal')
        assert.equal(projection.omittedSources.filter(value => value.reason === 'withdrawn').length, 5)
      } else if (requests > 1) {
        const audit = await readAudit()
        const result = audit.filter(event => event.type === 'context/semantic-result').at(-1)
        assert.equal(result.data.status, 'completed')
        assert.equal(result.data.projection.text, text)
      }
    }
    if (requests >= 5) for (const marker of ['RETRY_LIMIT_3', 'RETRY_LIMIT_1', 'FAILED_RETRY_9', 'src/retry.ts']) {
      assert.ok(!JSON.stringify(options.messages).includes(marker), 'current requests exclude withdrawn report bodies')
    }
    const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, requests === 6 ? 2 : 1)
    assert.ok(!events.some(event => event.type.startsWith('context/semantic-')))
    const observed = await activity()
    if (requests === 1 || requests === 6) assert.deepEqual(observed, noActivity)
    else {
      const request = events.findLast(event => event.type === 'scope-agent-context/request')
      assert.equal(request.data.turn, requests)
      assert.deepEqual(observed.request, activityRequest(request))
    }
    if (requests >= 5) assert.ok(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'development-task-context' && content(event.data).includes('RETRY_LIMIT_3')))
    assert.deepEqual(contexts(Session.create(agent.id, events, agent.session.header).deriveMessages()), visible,
      'detached Session replay reconstructs the actual adopted request context')
    yield* next()
  })
}
