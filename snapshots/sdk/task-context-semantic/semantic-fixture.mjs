/** Actual SDK requests use recipient summaries; the separate model route is fully controlled and keyless. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const packageRequire = createRequire(new URL('../../../packages/collaboration/development-task-context/package.json', import.meta.url))
const { Session } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-session')).href)
const { LlmAdapter } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-llm')).href)
const presenceUrl = pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-room-agent-presence')).href
const { developmentAgentParticipantId } = await import(presenceUrl)
const { peerContributionPayloadDigest } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-task')).href)

/** Loader fixture identity. */
export const name = 'task-context-semantic-snapshot'
/** Shared application services and this group's isolated audit persistence. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm', 'sessionPersistence', 'developmentTaskContextBackend']

const now = 1790985600000
const auditId = 'task-context-semantic-audit'
const ownerPeerId = '12D3KooWCMEyhAgjMNJghrqKxvCpLipFmnepRNXXPBxVrz1VBXVe'
const contributorPeerId = '12D3KooWFCgiTqWhtsJ1Zj49VtnbFN7F3t1NoMhpZHZnQiF5mr3E'
const nodeId = 'snapshot-semantic-owner'
const taskId = 'task-semantic-snapshot'
const bindingId = 'binding-semantic-snapshot'
const grant = {
  version: 1, taskId, grantId: 'grant-semantic-snapshot', generation: 'grant-generation-one',
  ownerPeerId, contributorPeerId, captureId: 'capture-semantic-snapshot', captureGeneration: 'capture-generation-one',
  source: { kind: 'tool-observations', name: 'session-work', tools: ['Edit', 'Write'] },
  expiresAt: now + 60000, maxSamples: 3, maxSampleBytes: 4096,
}
const reports = [
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/retry.ts', content: 'export const retryPolicy = "WRITE_ALPHA";\n' } },
  { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'docs/coordination.md', oldString: 'Manual synchronization',
      newString: 'EDIT_BETA: synchronize authorized work automatically', replaceAll: false } },
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'failure', omissions: ['content'],
    fields: { rootIndex: 0, path: 'src/retry.ts', error: 'FAILURE_GAMMA: permission denied' } },
]
const summaries = [
  { marker: 'WRITE_ALPHA', text: 'The source reports writing the implementation retry policy (WRITE_ALPHA).' },
  { marker: 'EDIT_BETA', text: 'The source reports editing the collaboration documentation (EDIT_BETA).' },
  { marker: 'FAILURE_GAMMA', text: 'A later Write failed with permission denied (FAILURE_GAMMA); it does not confirm a file update.' },
]
const digest = value => createHash('sha256').update(value).digest('hex')
const contexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const content = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

class ControlledSummaryAdapter extends LlmAdapter {
  constructor(readAudit) { super(); this.readAudit = readAudit; this.requests = [] }
  async * stream(options) {
    assert.equal(options.purpose, 'context-summary')
    assert.equal(options.sessionId, auditId)
    assert.deepEqual(options.tools ?? [], [])
    this.requests.push(options)
    const requests = (await this.readAudit()).filter(event => event.type === 'context/semantic-request')
    assert.equal(requests.length, this.requests.length)
    const request = requests.at(-1)
    assert.deepEqual(request.data.messages, options.messages)
    assert.equal(request.data.system, options.system)
    assert.equal(request.data.call.maxTokens, options.maxTokens)
    const input = JSON.parse(content(options.messages[0]))
    assert.equal(input.recipient.sessionLabel, 'Implementation and documentation')
    const decisions = []
    const updates = []
    for (const source of input.sources) {
      const summary = summaries.find(value => source.body.includes(value.marker))
      decisions.push({ sourceId: source.sourceId, relevant: summary !== undefined })
      if (summary !== undefined) updates.push({ text: summary.text, sources: [{ sourceId: source.sourceId, quote: summary.marker }] })
      else assert.ok(source.body.includes('UNRELATED_ADMIN'), 'only the controlled unrelated report may be omitted')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ version: 1, decisions, updates }) }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 80 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Feed fixture reports through production authority and inspect the actual frozen AgentLoop requests.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Services supplied by the shipped SDK profile and audit group.
 */
export async function apply(ctx) {
  ctx.effect(() => {
    const original = Date.now
    Date.now = () => now
    return () => { Date.now = original }
  })
  const readAudit = async () => {
    await using handle = await ctx.sessionPersistence.open(auditId, 'read')
    return (await handle.read()).events
  }
  const adapter = new ControlledSummaryAdapter(readAudit)
  ctx.effect(() => ctx.llm.registerAdapter(['semantic-snapshot'], adapter))
  const owner = 'snapshot-human-owner'
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  const unrelated = { id: 'publication-unrelated-admin', publishedBy: owner, publishedAt: now,
    text: 'UNRELATED_ADMIN: the office catering inventory has changed.' }
  ctx.developmentTasks.restoreLog([{
    nodeId, seq: 1, at: now, taskId, revision: 1, hiddenRoomId: 'room-semantic-snapshot',
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: 'Coordinate implementation and documentation from authorized peer work.',
      scope: 'Treat tool reports as attributed events; do not infer a verified current file snapshot.' },
  }, { nodeId, seq: 2, at: now, taskId, revision: 2, hiddenRoomId: 'room-semantic-snapshot',
    change: { kind: 'context-published', publication: unrelated } }])
  await ctx.developmentTasks.openPeerContribution(grant)
  let activeAgent
  let observedTurn = 0
  let ordinaryRequests = 0
  const admitted = []
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    assert.equal(turn, observedTurn + 1)
    assert.ok(turn <= 4)
    if (turn === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot recipient' })
      await ctx.developmentTasks.checkout({ taskId, participantId, bindingId, sessionLabel: 'Implementation and documentation' })
    }
    if (turn < 4) {
      const request = { grant, sourceId: digest(`semantic-snapshot/${turn}`), sequence: turn, result: reports[turn - 1] }
      const result = await ctx.developmentTasks.admitPeerContribution(request, contributorPeerId)
      assert.equal(result.outcome, 'published')
      assert.equal(result.receipt.payloadDigest, peerContributionPayloadDigest(request))
      admitted.push(result.publication)
    } else {
      const ended = await ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, ownerPeerId)
      assert.equal(ended.event.kind, 'peer-contribution-ended')
    }
    activeAgent = agent
    observedTurn = turn
    return decision
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose === 'context-summary') return yield* next()
    ordinaryRequests++
    assert.equal(ordinaryRequests, observedTurn)
    assert.equal(adapter.requests.length, observedTurn)
    assert.ok(activeAgent)
    const visible = contexts(options.messages)
    assert.equal(visible.length, 1)
    const message = visible[0]
    assert.equal(message.source.backend.id, 'semantic')
    assert.equal(message.source.revision, observedTurn + 3)
    const json = content(message).split('<shared-work-updates>\n')[1]?.split('\n</shared-work-updates>')[0]
    assert.ok(json)
    const projection = JSON.parse(json)
    assert.deepEqual(projection.coverage.omittedSources, message.source.omittedSources)
    assert.deepEqual(projection.coverage.selectedSources, message.source.selectedSources)
    assert.ok(message.source.omittedSources.some(item => item.reason === 'recipient-irrelevant'
      && item.source.publicationId === unrelated.id))
    assert.ok(!JSON.stringify(options.messages).includes('UNRELATED_ADMIN'))
    if (observedTurn < 4) {
      assert.deepEqual(projection.updates.map(update => update.text), summaries.slice(0, observedTurn).map(value => value.text))
      for (const [index, update] of projection.updates.entries()) {
        assert.equal(update.sources[0].source.publicationId, admitted[index].id)
        assert.equal(update.sources[0].quote, summaries[index].marker)
        assert.equal(update.sources[0].attribution.authorization.contributorPeerId, contributorPeerId)
      }
    } else {
      assert.deepEqual(projection.updates, [])
      assert.equal(projection.mandatory.length, 1)
      assert.equal(projection.mandatory[0].kind, 'withdrawal')
      assert.equal(message.source.omittedSources.filter(item => item.reason === 'withdrawn').length, 3)
      for (const value of ['WRITE_ALPHA', 'EDIT_BETA', 'FAILURE_GAMMA', 'src/retry.ts', 'docs/coordination.md']) {
        assert.ok(!JSON.stringify(options.messages).includes(value), 'withdrawn reports must not remain in the actual request')
      }
    }
    const audit = await readAudit()
    const result = audit.filter(event => event.type === 'context/semantic-result').at(-1)
    const request = audit.find(event => event.type === 'context/semantic-request' && event.seq === result.data.requestSeq)
    assert.equal(result.data.status, 'completed')
    assert.equal(result.data.key, request.data.key)
    assert.equal(result.data.projection.text, content(message))
    assert.deepEqual(result.data.projection.selectedSources, message.source.selectedSources)
    assert.deepEqual(result.data.projection.omittedSources, message.source.omittedSources)
    const events = JSON.parse(JSON.stringify(activeAgent.session.snapshotEvents()))
    const history = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context')
    assert.equal(history.length, observedTurn)
    assert.ok(content(history[0].data).includes('WRITE_ALPHA'))
    assert.ok(!events.some(event => event.type.startsWith('context/semantic-')), 'audit events belong to the isolated auxiliary Session')
    const replay = Session.create(activeAgent.id, events, activeAgent.session.header)
    assert.deepEqual(contexts(replay.deriveMessages()), visible, 'detached replay must reconstruct exact adopted semantic context')
    yield* next()
  })
}
