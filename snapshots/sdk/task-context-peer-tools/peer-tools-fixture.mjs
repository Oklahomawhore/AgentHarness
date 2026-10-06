/** Exercise owner-admitted tool reports in native requests and detached Session replay. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const packageRequire = createRequire(new URL('../../../packages/collaboration/development-task-context/package.json', import.meta.url))
const { Session } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-session')).href)
const { developmentAgentParticipantId } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-room-agent-presence')).href)
const { peerContributionPayloadDigest } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-task')).href)

/** Loader fixture identity. */
export const name = 'task-context-peer-tools-snapshot'
/** Production services that admit reports and assemble actual requests. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm']

const now = 1790985600000
const ownerPeerId = '12D3KooWCMEyhAgjMNJghrqKxvCpLipFmnepRNXXPBxVrz1VBXVe'
const contributorPeerId = '12D3KooWFCgiTqWhtsJ1Zj49VtnbFN7F3t1NoMhpZHZnQiF5mr3E'
const nodeId = 'snapshot-task-owner'
const taskId = 'task-peer-tools-snapshot'
const bindingId = 'binding-peer-tools-snapshot'
const grant = {
  version: 1, taskId, grantId: 'grant-tools-peer-snapshot', generation: 'grant-generation-one',
  ownerPeerId, contributorPeerId, captureId: 'capture-tools-peer-snapshot', captureGeneration: 'capture-generation-one',
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
const digest = value => createHash('sha256').update(value).digest('hex')
const contexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const content = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/**
 * Drive four states through production Task admission; reports are fixture inputs, not external tool execution.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed SDK profile services.
 */
export async function apply(ctx) {
  // This fixture owns the subprocess; semantic timestamps are fixed while timers remain real.
  ctx.effect(() => {
    const original = Date.now
    Date.now = () => now
    return () => { Date.now = original }
  })
  const owner = 'snapshot-human-owner'
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  ctx.developmentTasks.restoreLog([{
    nodeId, seq: 1, at: now, taskId, revision: 1, hiddenRoomId: 'room-peer-tools-snapshot',
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: 'Coordinate implementation and documentation from peer tool reports.',
      scope: 'Treat reports as attributed events; do not infer a verified current file snapshot.' },
  }])
  const opened = await ctx.developmentTasks.openPeerContribution(grant)
  assert.equal(opened.state, 'active')
  assert.equal(opened.openReceipt.event.kind, 'peer-contribution-opened')
  let activeAgent
  let observedTurn = 0
  let requests = 0
  const admitted = []
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    assert.equal(turn, observedTurn + 1)
    assert.ok(turn <= 4)
    if (turn === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot receiver' })
      await ctx.developmentTasks.checkout({ taskId, participantId, bindingId, sessionLabel: 'Implementation and documentation' })
    }
    if (turn < 4) {
      const input = { grant, sourceId: digest(`peer-tools-snapshot/${turn}`), sequence: turn, result: reports[turn - 1] }
      const result = await ctx.developmentTasks.admitPeerContribution(input, contributorPeerId)
      assert.equal(result.outcome, 'published')
      assert.equal(result.receipt.ownerPeerId, ownerPeerId)
      assert.equal(result.receipt.contributorPeerId, contributorPeerId)
      assert.equal(result.receipt.event.nodeId, nodeId)
      assert.equal(result.receipt.event.kind, 'context-published')
      assert.equal(result.receipt.payloadDigest, peerContributionPayloadDigest(input))
      assert.equal(result.publication.publishedBy, undefined)
      admitted.push({ input, receipt: result.receipt, publication: result.publication })
    } else {
      const ended = await ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, ownerPeerId)
      assert.equal(ended.event.kind, 'peer-contribution-ended')
      const retry = await ctx.developmentTasks.admitPeerContribution(admitted[0].input, contributorPeerId)
      assert.equal(retry.outcome, 'reused')
      assert.deepEqual(retry.receipt, admitted[0].receipt)
      assert.equal(ctx.developmentTasks.peerContributions({ taskId })[0].state, 'ended')
    }
    activeAgent = agent
    observedTurn = turn
    return decision
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.equal(requests, observedTurn)
    assert.ok(activeAgent)
    const visible = contexts(options.messages)
    assert.equal(visible.length, 1)
    const message = visible[0]
    assert.deepEqual(message.source.backend, { id: 'text', revision: '8' })
    assert.ok(Buffer.byteLength(content(message), 'utf8') <= 6000, 'the complete context must fit the default read budget')
    assert.equal(message.source.revision, observedTurn + 2)
    assert.deepEqual(message.source.bindingEpoch, { nodeId, seq: 1 })
    assert.equal(message.source.omittedSources.some(item => item.reason === 'budget'), false)
    const json = content(message).split('<development-task-context>\n')[1]?.split('\n</development-task-context>')[0]
    assert.ok(json)
    const projection = JSON.parse(json)
    assert.equal(projection.publications.length, observedTurn === 4 ? 1 : observedTurn)
    if (observedTurn < 4) {
      for (const [index, publication] of projection.publications.entries()) {
        assert.equal(Object.hasOwn(publication, 'peerToolObservation'), false, 'the delivered report must not repeat its body')
        assert.equal(publication.text, admitted[index].publication.text, 'projection must retain the exact owner-produced text')
        const separator = publication.text.lastIndexOf('\n')
        assert.ok(separator >= 0, 'canonical report text includes its JSON observation after the warning')
        const serialized = publication.text.slice(separator + 1)
        const observation = JSON.parse(serialized)
        assert.equal(JSON.stringify(observation), serialized, 'the complete observation remains byte-for-byte recoverable')
        assert.deepEqual(observation, admitted[index].publication.peerToolObservation)
        const { sourceName, grantId, sequence, observerPeerId, sourceId, capture, ...report } = observation
        assert.deepEqual(report, reports[index])
        assert.equal(observerPeerId, contributorPeerId)
        assert.equal(sourceName, grant.source.name)
        assert.equal(grantId, grant.grantId)
        assert.equal(sequence, index + 1)
        assert.equal(sourceId, admitted[index].input.sourceId)
        assert.deepEqual(capture, { id: grant.captureId, generation: grant.captureGeneration })
        assert.ok(publication.text.includes('not a current file snapshot'))
        assert.ok(message.source.selectedSources.some(source => source.publicationId === publication.id))
      }
    } else {
      assert.deepEqual(projection.publications[0].peerContribution, { version: 1, grant, ended: 'revoked' })
      assert.equal(projection.coverage.withdrawnOmissions, 3)
      assert.equal(message.source.omittedSources.filter(item => item.reason === 'withdrawn').length, 3)
      for (const value of ['WRITE_ALPHA', 'EDIT_BETA', 'FAILURE_GAMMA', 'src/retry.ts', 'docs/coordination.md']) {
        assert.ok(!JSON.stringify(options.messages).includes(value), 'withdrawn reports must not remain in the current request')
      }
    }
    const events = JSON.parse(JSON.stringify(activeAgent.session.snapshotEvents()))
    const history = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context')
    assert.equal(history.length, observedTurn)
    assert.ok(content(history[0].data).includes('WRITE_ALPHA'), 'withdrawal retains original evidence in the append-only log')
    const replay = Session.create(activeAgent.id, events, activeAgent.session.header)
    assert.deepEqual(contexts(replay.deriveMessages()), visible, 'detached replay reconstructs the exact current source projection')
    return next()
  })
}
