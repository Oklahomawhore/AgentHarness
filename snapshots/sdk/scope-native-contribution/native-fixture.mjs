/** Source tools and durable evidence feed an independent owner, then actual receiver requests through the SDK profile. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from './hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { Context } = await load('@deepseek-ai/cordis')
const { default: JsonlPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')

/** Loader fixture identity. */
export const name = 'scope-native-contribution-snapshot'
/** Receiver services supplied by the real SDK composition. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'developmentTasks', 'llm']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const scopeMessages = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const textReply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const toolReply = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]

async function until(label, predicate) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`native snapshot did not observe ${label}`)
    await setTimeout(10)
  }
}

/** Drive real native mutation and observe receiver requests; no Hook or publication is fabricated. */
export async function apply(ctx) {
  const directory = join(process.cwd(), '.dsh', 'native-fixture')
  const owner = await host(join(directory, 'owner'), 'owner')
  ctx.effect(() => owner.close)
  const source = await host(join(directory, 'source'), 'source')
  ctx.effect(() => source.close)
  const sourceAgent = (await source.ctx.agents.create({ sessionId: 'native-fixture-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: source.workspace } })).agent
  const allowed = join(source.workspace, 'project')
  await mkdir(join(allowed, 'src'), { recursive: true })
  await mkdir(join(allowed, 'docs'))
  await owner.ctx.developmentRooms.announce({ id: 'native-fixture-owner', kind: 'human', displayName: 'Native fixture owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'native-fixture-owner',
    objective: 'Keep the client and guide aligned from source work.', scope: 'Tool reports are attributed events, not verified current files.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: Date.now() + 50000 })
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: sourceAgent.id, expectedCapture: null,
    entry: entry.entry, roots: [allowed], tools: ['write', 'edit'], limits })
  assert.ok(requested.capture)
  await until('owner pending application', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status === 'pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: requested.capture.proposal, limits, ownerAddress })
  await until('automatic source activation', async () => (await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id })).capture?.collecting)
  const active = (await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id })).capture
  assert.ok(active?.invitation)
  const reader = new Context()
  await reader.plugin(JsonlPersistence, { root: join(source.root, 'sessions'), compression: 'none' })
  ctx.effect(() => () => reader.fiber.dispose())
  let sentSamples = 0
  source.ctx.scopeTransport.beforeSample = async () => {
    await using handle = await reader.sessionPersistence.open(sourceAgent.id, 'read')
    const records = (await handle.read()).events
    assert.ok(records.filter(event => event.type === 'tool/result').length > sentSamples,
      'the actual source tool result must be physically durable before sending its observation')
    sentSamples++
  }
  const runSource = async responses => {
    source.adapter.script.push(...responses, textReply('Source work completed.'))
    sourceAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Perform the approved source work.' }] }))
    await sourceAgent.whenIdle()
    assert.deepEqual(sourceAgent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    assert.equal(source.adapter.script.length, 0)
  }
  let receiver
  let observedTurn = 0
  let requests = 0
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    receiver = agent
    assert.equal(turn, observedTurn + 1)
    if (turn === 1) {
      await runSource([
        toolReply('source-write-client', 'write', { file_path: 'project/src/client.ts', content: 'export const mode = "NATIVE_ALPHA";\n' }),
        toolReply('source-write-guide', 'write', { file_path: 'project/docs/guide.md', content: 'NATIVE_BETA: keep the client and guide aligned.\n' }),
        toolReply('source-edit-client', 'edit', { file_path: 'project/src/client.ts', old_string: 'NATIVE_ALPHA', new_string: 'NATIVE_CORRECTED' }),
      ])
      await until('three owner publications', () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length === 3)
      assert.equal(await readFile(join(allowed, 'src/client.ts'), 'utf8'), 'export const mode = "NATIVE_CORRECTED";\n')
      assert.ok((await readFile(join(allowed, 'docs/guide.md'), 'utf8')).includes('NATIVE_BETA'))
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: Date.now() + 50000,
        responsibility: 'Maintain the client and guide from reported source work.' })
      const receiving = await ctx.scopeAgentContext.status({ agentId: agent.id })
      assert.notEqual(receiving.eligibility, 'not-live')
      const adoption = { agentId: agent.id, adoptionId: '6de9d490-b4ce-487c-a620-1fa86804dd85',
        expectedReadStateSeq: receiving.readStateSeq, invitation }
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead(adoption), { status: 'adopted' })
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead(adoption), { status: 'adopted' })
      const phases = agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')
      assert.deepEqual(phases.map(event => event.data.phase), ['planned', 'adopted'])
    } else if (turn === 2) {
      await runSource([toolReply('source-failed-edit', 'edit', { file_path: 'project/src/client.ts', old_string: 'DOES_NOT_EXIST', new_string: 'NEVER_APPLIED' })])
      await until('failed Edit publication', () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length === 4)
      const failure = owner.ctx.developmentTasks.get({ taskId: task.id }).context[3].peerToolObservation
      assert.equal(failure.reportedStatus, 'failure')
      assert.ok(!Object.hasOwn(failure.fields, 'newString'))
      assert.ok(failure.omissions.includes('oldString') && failure.omissions.includes('newString'))
    } else {
      assert.equal(turn, 3)
      await owner.ctx.scopeAccess.revokeContribution({ grant: active.invitation.grant })
    }
    observedTurn = turn
    return await next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.equal(requests, observedTurn)
    const visible = scopeMessages(options.messages)
    assert.equal(visible.length, 1)
    const projection = visible[0].source.projection
    assert.equal(projection.backend.id, 'text')
    assert.equal(projection.backend.revision, '6')
    assert.equal(projection.taskRevision, requests + 4)
    const text = options.messages.map(body).join('\n')
    if (requests < 3) {
      for (const marker of ['NATIVE_ALPHA', 'NATIVE_BETA', 'NATIVE_CORRECTED']) assert.ok(text.includes(marker))
      assert.ok(text.includes('not a current file snapshot'))
      assert.ok(text.includes('snapshot-native-source-peer'))
      assert.equal(sentSamples, requests === 1 ? 3 : 4)
    } else {
      for (const marker of ['NATIVE_ALPHA', 'NATIVE_BETA', 'NATIVE_CORRECTED', 'NEVER_APPLIED']) assert.ok(!text.includes(marker))
      assert.ok(text.includes('revoked'))
      assert.equal(projection.omittedSources.filter(item => item.reason === 'withdrawn').length, 4)
    }
    if (requests === 2) { assert.ok(text.includes('failure')); assert.ok(!text.includes('NEVER_APPLIED')) }
    assert.deepEqual(ctx.developmentTasks.list({ limit: 32 }), [])
    assert.deepEqual(source.ctx.developmentTasks.list({ limit: 32 }), [])
    assert.equal(receiver.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0, 'recipient does not recall or fetch the reports with a tool')
    const events = JSON.parse(JSON.stringify(receiver.session.snapshotEvents()))
    const replay = Session.create(receiver.id, events, receiver.session.header)
    assert.deepEqual(scopeMessages(replay.deriveMessages()), visible)
    const original = events.find(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')
    assert.ok(body(original.data).includes('NATIVE_BETA'), 'source withdrawal does not erase the original Session evidence')
    return next()
  })
}
