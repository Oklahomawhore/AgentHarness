/** Exercise owner-admitted peer reports in actual native requests and detached Session replay. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const packageRequire = createRequire(new URL('../../../packages/collaboration/development-task-context/package.json', import.meta.url))
const { Session } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-session')).href)
const { developmentAgentParticipantId } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-room-agent-presence')).href)
const { peerContributionArtifactId, peerContributionPayloadDigest } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-task')).href)

/** Loader fixture identity. */
export const name = 'task-context-peer-facts-snapshot'
/** Production services that admit reports and assemble the actual request. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm']

const now = 1790985600000
const ownerPeerId = '12D3KooWCMEyhAgjMNJghrqKxvCpLipFmnepRNXXPBxVrz1VBXVe'
const contributorPeerId = '12D3KooWFCgiTqWhtsJ1Zj49VtnbFN7F3t1NoMhpZHZnQiF5mr3E'
const nodeId = 'snapshot-task-owner'
const taskId = 'task-peer-facts-snapshot'
const bindingId = 'binding-peer-facts-snapshot'
const grant = {
  version: 1, taskId, grantId: 'grant-orders-peer-snapshot', generation: 'grant-generation-one',
  ownerPeerId, contributorPeerId, captureId: 'capture-orders-peer-snapshot', captureGeneration: 'capture-generation-one',
  source: { name: 'Orders API', method: 'post', path: '/orders' }, expiresAt: now + 60000,
  maxSamples: 3, maxSampleBytes: 4096,
}
const initial = {
  operationId: 'createPeerOrderV1', requestBodyRequired: true,
  requiredRequestFields: ['legacyPeerSku'], responseStatuses: ['200'], deprecated: false,
}
const corrected = {
  operationId: 'createPeerOrderV2', requestBodyRequired: false,
  requiredRequestFields: ['peerSku'], responseStatuses: ['201', 'default'], deprecated: true,
}
const digest = value => createHash('sha256').update(value).digest('hex')
const contexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const content = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/**
 * Drive four ordered states with fixture-owned reports; no transport or real model participates.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed SDK profile services.
 */
export async function apply(ctx) {
  // The fixture owns this entire subprocess. Keep semantic commit clocks stable without replacing timers.
  ctx.effect(() => {
    const original = Date.now
    Date.now = () => now
    return () => { Date.now = original }
  })
  const owner = 'snapshot-human-owner'
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  ctx.developmentTasks.restoreLog([{
    nodeId, seq: 1, at: now, taskId, revision: 1, hiddenRoomId: 'room-peer-facts-snapshot',
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: 'Integrate the peer-reported orders API.', scope: 'Use current declarations within the owner-approved source grant.' },
  }])
  const opened = await ctx.developmentTasks.openPeerContribution(grant)
  assert.equal(opened.state, 'active')
  assert.equal(opened.openReceipt.event.kind, 'peer-contribution-opened')
  assert.equal(opened.openReceipt.event.nodeId, nodeId)
  let activeAgent
  let sampledTurn = 0
  let requests = 0
  const admitted = []
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    assert.equal(turn, sampledTurn + 1, 'one actual request is expected for each fixture user turn')
    assert.ok(turn <= 4)
    if (turn === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot receiver' })
      await ctx.developmentTasks.checkout({ taskId, participantId, bindingId, sessionLabel: 'API consumer' })
    }
    if (turn < 4) {
      const facts = turn === 1 ? initial : corrected
      const input = {
        grant, sourceId: digest(`peer-facts-snapshot/${turn}`), sequence: turn,
        result: turn === 3 ? { state: 'invalid', sha256: digest('{ "openapi":'), reason: 'invalid-json' }
          : { state: 'valid', sha256: digest(JSON.stringify(facts)), facts },
      }
      const result = await ctx.developmentTasks.admitPeerContribution(input, contributorPeerId)
      assert.equal(result.outcome, 'published')
      assert.equal(result.receipt.ownerPeerId, ownerPeerId)
      assert.equal(result.receipt.contributorPeerId, contributorPeerId)
      assert.equal(result.receipt.event.nodeId, nodeId)
      assert.equal(result.receipt.event.kind, 'context-published')
      assert.equal(result.receipt.payloadDigest, peerContributionPayloadDigest(input))
      assert.equal(result.publication.publishedBy, undefined, 'peer identity is not a fabricated local participant')
      admitted.push({ input, receipt: result.receipt })
    } else {
      const end = await ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, ownerPeerId)
      assert.equal(end.event.kind, 'peer-contribution-ended')
      const retry = await ctx.developmentTasks.admitPeerContribution(admitted[0].input, contributorPeerId)
      assert.equal(retry.outcome, 'reused')
      assert.deepEqual(retry.receipt, admitted[0].receipt, 'a late exact retry returns its original commit without reviving evidence')
      assert.equal(ctx.developmentTasks.peerContributions({ taskId })[0].state, 'ended')
    }
    activeAgent = agent
    sampledTurn = turn
    return decision
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.equal(requests, sampledTurn)
    assert.ok(activeAgent)
    const visible = contexts(options.messages)
    assert.equal(visible.length, 1)
    const message = visible[0]
    assert.equal(message.source.backend.id, 'openapi-facts')
    assert.equal(message.source.revision, sampledTurn + 2)
    assert.deepEqual(message.source.bindingEpoch, { nodeId, seq: 1 })
    assert.equal(message.source.omittedSources.some(item => item.reason === 'budget'), false)
    const json = content(message).split('<development-task-facts>\n')[1]?.split('\n</development-task-facts>')[0]
    assert.ok(json)
    const projection = JSON.parse(json)
    assert.equal(projection.artifacts.length, 1)
    const group = projection.artifacts[0]
    assert.equal(group.artifactId, peerContributionArtifactId(grant))
    assert.equal(group.basis, 'current-task-as-sampled')
    assert.equal(group.chains.length, 1)
    const chain = group.chains[0]
    assert.equal(chain.heads.length, 1)
    assert.equal(chain.supersededCount, sampledTurn - 1)
    const head = chain.heads[0]
    assert.equal(head.sequence, sampledTurn)
    assert.equal(head.observerPeerId, contributorPeerId)
    assert.equal(head.observerNodeId, undefined)
    assert.equal(head.attribution, 'authenticated-peer-report')
    assert.deepEqual(head.capture, { id: grant.captureId, generation: grant.captureGeneration })
    if (sampledTurn < 3) {
      assert.equal(group.evidence, 'consistent')
      assert.equal(head.state, 'valid')
      assert.deepEqual(head.facts, sampledTurn === 1 ? initial : corrected)
    } else {
      assert.equal(group.evidence, sampledTurn === 3 ? 'unavailable' : 'revoked')
      assert.equal(head.state, sampledTurn === 3 ? 'invalid' : 'revoked')
      assert.equal(head.reason, sampledTurn === 3 ? 'invalid-json' : 'grant-ended')
      assert.equal(head.facts, undefined)
    }
    if (sampledTurn === 4) {
      assert.equal(projection.withdrawals.length, 1)
      assert.deepEqual(projection.withdrawals[0].peerContribution, { version: 1, grant, ended: 'revoked' })
      assert.ok(message.source.selectedSources.some(source => source.publicationId === projection.withdrawals[0].id))
    }
    const allText = JSON.stringify(options.messages)
    if (sampledTurn >= 2) assert.ok(!allText.includes('legacyPeerSku') && !allText.includes('createPeerOrderV1'))
    if (sampledTurn >= 3) assert.ok(!allText.includes('peerSku') && !allText.includes('createPeerOrderV2'))
    const events = JSON.parse(JSON.stringify(activeAgent.session.snapshotEvents()))
    const history = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context')
    assert.equal(history.length, sampledTurn)
    assert.ok(content(history[0].data).includes('legacyPeerSku'), 'withdrawal preserves prior evidence in the append-only log')
    const replay = Session.create(activeAgent.id, events, activeAgent.session.header)
    assert.deepEqual(contexts(replay.deriveMessages()), visible, 'detached replay reconstructs the exact current request evidence')
    return next()
  })
}
