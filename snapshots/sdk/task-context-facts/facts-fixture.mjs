/** Exercise native request projection with fixture-authored, Host-admitted artifact observations. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve published exports from the package that declares these fixture dependencies.
const packageRequire = createRequire(new URL('../../../packages/collaboration/development-task-context/package.json', import.meta.url))
const { Session } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-session')).href)
const { developmentAgentParticipantId } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-development-room-agent-presence')).href)

/** Loader fixture identity. */
export const name = 'task-context-facts-snapshot'
/** Real services used to admit evidence and observe assembled model requests. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'llm']

const initial = {
  operationId: 'createOrderV1', requestBodyRequired: true,
  requiredRequestFields: ['legacySku'], responseStatuses: ['200'], deprecated: false,
}
const updated = {
  operationId: 'createOrderV2', requestBodyRequired: false,
  requiredRequestFields: ['sku'], responseStatuses: ['201', 'default'], deprecated: true,
}

function document(facts) {
  return JSON.stringify({
    openapi: '3.1.1', info: { title: 'Fixture API', version: '1' },
    paths: { '/orders': { post: {
      operationId: facts.operationId, deprecated: facts.deprecated,
      requestBody: { required: facts.requestBodyRequired, content: { 'application/json': {
        schema: { type: 'object', required: facts.requiredRequestFields },
      } } },
      responses: Object.fromEntries(facts.responseStatuses.map(status => [status, { description: 'Fixture response' }])),
    } } },
  })
}

function contexts(messages) {
  return messages.filter(message => message.source.kind === 'development-task-context')
}

/**
 * Admit three controlled samples and verify actual model requests plus detached Session replay.
 * This fixture owns its facts; production OpenAPI parsing is exercised by the adapter regressions.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed SDK profile services.
 */
export async function apply(ctx) {
  const directory = await mkdtemp(join(tmpdir(), 'task-context-facts-'))
  ctx.effect(() => () => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'openapi.json')
  const nodeId = 'snapshot-node'
  const owner = 'snapshot-owner'
  const taskId = 'task-facts-snapshot'
  const bindingId = 'binding-facts-snapshot'
  const observerId = 'snapshot-artifact-observer'
  const observerBindingId = 'binding-artifact-observer'
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Snapshot owner' })
  ctx.developmentTasks.restoreLog([{
    nodeId, seq: 1, at: 1, taskId, revision: 1, hiddenRoomId: 'room-facts-snapshot',
    change: { kind: 'task-created', origin: { kind: 'root' }, createdBy: owner,
      objective: 'Integrate the orders API.', scope: 'Use the latest supported sampled declarations.' },
  }])
  await ctx.developmentRooms.announce({ id: observerId, kind: 'agent', displayName: 'Fixture artifact observer' })
  await ctx.developmentTasks.checkout({ taskId, participantId: observerId, bindingId: observerBindingId })
  const bound = ctx.developmentTasks.assignmentLog().findLast(entry => entry.bindingId === observerBindingId && entry.change.kind === 'task-bound')
  assert.ok(bound)
  let activeAgent
  let sampledTurn = 0
  let requests = 0
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    assert.equal(turn, sampledTurn + 1, 'fixture expects one request for each of three user turns')
    assert.ok(turn <= 3)
    const participantId = developmentAgentParticipantId(agent.id)
    if (turn === 1) {
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Snapshot Agent' })
      await ctx.developmentTasks.checkout({ taskId, participantId, bindingId, sessionLabel: 'API consumer' })
    }
    const facts = turn === 1 ? initial : updated
    await writeFile(file, turn === 3 ? '{ "openapi":' : document(facts))
    const bytes = await readFile(file)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await ctx.developmentTasks.admitObservedContext({
      taskId, participantId: observerId, bindingId: observerBindingId, expectedBindingEpoch: { nodeId: bound.nodeId, seq: bound.seq },
      sourceId: createHash('sha256').update(`facts-snapshot/${turn}`).digest('hex'),
      text: 'Fixture-controlled OpenAPI artifact observation.',
      observation: {
        kind: 'openapi-artifact', version: 1, artifactId: 'artifact-orders-snapshot', sourceName: 'Orders API',
        grantId: 'grant-orders-snapshot', sequence: turn, operation: { method: 'post', path: '/orders' },
        ...(turn === 3 ? { state: 'invalid', sha256, reason: 'invalid-json' } : { state: 'valid', sha256, facts }),
      },
    })
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
    assert.equal(message.source.revision, sampledTurn + 1)
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    const json = text.split('<development-task-facts>\n')[1]?.split('\n</development-task-facts>')[0]
    assert.ok(json)
    const projection = JSON.parse(json)
    assert.equal(projection.artifacts.length, 1)
    const group = projection.artifacts[0]
    assert.equal(group.basis, 'current-task-as-sampled')
    assert.equal(group.chains.length, 1)
    assert.equal(group.chains[0].heads.length, 1)
    assert.equal(group.chains[0].superseded.length, Math.min(sampledTurn - 1, 1))
    assert.equal(group.chains[0].supersededCount, sampledTurn - 1)
    assert.equal(projection.coverage.supersededSources, Math.max(sampledTurn - 2, 0))
    const omittedHistory = message.source.omittedSources.filter(item => item.reason === 'superseded')
    assert.equal(omittedHistory.length, Math.max(sampledTurn - 2, 0))
    if (sampledTurn > 1) {
      assert.equal(group.chains[0].superseded[0].sequence, sampledTurn - 1)
      assert.equal(group.chains[0].superseded[0].state, 'valid')
      assert.equal(group.chains[0].superseded[0].facts, undefined)
    }
    if (sampledTurn === 3) {
      const oldestPublication = `context-observation-${createHash('sha256').update('facts-snapshot/1').digest('hex')}`
      assert.equal(omittedHistory[0].source.publicationId, oldestPublication)
      assert.ok(!message.source.selectedSources.some(source => source.publicationId === oldestPublication))
    }
    const head = group.chains[0].heads[0]
    assert.equal(head.sequence, sampledTurn)
    if (sampledTurn === 3) {
      assert.equal(group.evidence, 'unavailable')
      assert.equal(head.state, 'invalid')
      assert.equal(head.reason, 'invalid-json')
      assert.equal(head.facts, undefined)
    } else {
      assert.equal(group.evidence, 'consistent')
      assert.equal(head.state, 'valid')
      assert.deepEqual(head.facts, sampledTurn === 1 ? initial : updated)
    }
    const allText = JSON.stringify(options.messages)
    if (sampledTurn >= 2) assert.ok(!allText.includes('legacySku') && !allText.includes('createOrderV1'))
    if (sampledTurn === 3) assert.ok(!allText.includes('createOrderV2'))
    const events = JSON.parse(JSON.stringify(activeAgent.session.snapshotEvents()))
    const history = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context')
    assert.equal(history.length, sampledTurn, 'earlier projections remain in the append-only log')
    assert.ok(JSON.stringify(history[0]).includes('legacySku'))
    const replay = Session.create(activeAgent.id, events, activeAgent.session.header)
    assert.deepEqual(contexts(replay.deriveMessages()), visible, 'Session replay reconstructs exactly the current model-visible facts')
    return next()
  })
}
