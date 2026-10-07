/** Two existing native Sessions retain complete useful facts within the receiver's smaller context allowance. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-group-join/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-recipient-budget-snapshot'
/** Services supplied by the supported SDK profile and its owned overlay. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm', 'sessions', 'sessionPersistence']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => ['development-task-context', 'scope-agent-context'].includes(message.source.kind))
const parsed = text => JSON.parse(text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const write = (id, path, content) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: JSON.stringify({ file_path: path, content }) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]
/** Drive real tool completions and inspect exact requests before any snapshot normalization. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('recipient budget fixture disposed')))
  const wait = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`recipient budget did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  // The shared helper's c role supplies a native Agent; this Host owns the shared Task in this scene.
  const owner = await host(join(process.cwd(), '.dsh/budget-owner'), 'c', { maxContextBytes: 12000, maxLocalContextBytes: 6000 })
  ctx.effect(() => owner.close)
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  const contents = [1, 2, 3].map(index => `export const OWNER_BUDGET_GROUP_${index} = '${'界'.repeat(750)}';\n`)
  const state = item => item.ctx.sessionProjections.stateOf(item.agent.session, 'scopeAgentContext')
  const setup = async (context, agent, key) => {
    const participantId = developmentAgentParticipantId(agent.id)
    await context.developmentRooms.announce({ id: `budget-${key}-human`, kind: 'human', displayName: `Person ${key}` })
    await context.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: `Existing ${key} Session` })
    const task = await context.developmentTasks.create({ origin: { kind: 'root' }, createdBy: `budget-${key}-human`,
      objective: `Maintain ${key} responsibility.`, scope: `Only approved ${key} file work may be shared.` })
    const bindingId = `budget-${key}-binding`
    await context.developmentTasks.checkout({ taskId: task.id, participantId, bindingId })
    const epoch = context.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
    const target = { taskId: task.id, taskBindingId: bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
    await context.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
    return { ctx: context, agent, key, task, target, requests: [], original: await context.scopeAgentContributions.localStatus({ agentId: agent.id }),
      tools: structuredClone(agent.ctx.get('tools').schemas()), history: undefined, lastContexts: undefined }
  }
  let a
  let b
  let capture
  let binding
  let rawProjection
  let aPhase
  let turn = 0
  let step = 0
  const localReports = () => owner.ctx.developmentTasks.get({ taskId: a.task.id }).context.filter(item => item.localToolObservation !== undefined)
  const peerReports = () => owner.ctx.developmentTasks.get({ taskId: a.task.id }).context.filter(item => item.peerToolObservation !== undefined)
  const assertLocal = async () => {
    const local = await ctx.scopeAgentContributions.localStatus({ agentId: b.agent.id })
    assert.deepEqual(local.assignment, b.original.assignment)
    assert.equal(local.capture, null, 'first-use receiving never creates an implicit local capture')
    assert.equal(ctx.agents.get(b.agent.id), b.agent)
    assert.deepEqual(b.agent.ctx.get('tools').schemas(), b.tools)
    if (b.history !== undefined) assert.deepEqual(b.agent.session.snapshotEvents().slice(0, b.history.length), b.history)
  }
  const inspect = (item, options, phase, allowance) => {
    const visible = contexts(options.messages)
    item.lastContexts = visible
    const local = visible.find(message => message.source.kind === 'development-task-context')
    const remote = visible.find(message => message.source.kind === 'scope-agent-context')
    assert.equal(local.source.projection.taskId, item.task.id)
    assert.deepEqual(local.source.projection.bindingEpoch, item.target.expectedBindingEpoch)
    const bytes = visible.reduce((sum, message) => sum + Buffer.byteLength(body(message), 'utf8'), 0)
    assert.ok(bytes <= allowance)
    assert.equal(state(item).automatic, null)
    assert.equal(state(item).usedBudget, 0)
    assert.deepEqual(contexts(Session.create(item.agent.id, structuredClone(item.agent.session.snapshotEvents()), item.agent.session.header).deriveMessages()), visible)
    const localText = body(local)
    const remoteText = remote === undefined ? null : body(remote)
    const projection = remote?.source.form === 'snapshot' ? remote.source.projection : null
    const remoteFrameBytes = remoteText === null ? 0 : Buffer.byteLength(remoteText, 'utf8')
    const remoteProjectionBytes = projection === null ? null : Buffer.byteLength(projection.text, 'utf8')
    item.requests.push({ phase, bytes, localText, localBytes: Buffer.byteLength(localText, 'utf8'), remoteForm: remote?.source.form ?? null,
      remoteText, remoteFrameBytes, remoteProjectionBytes,
      framingBytes: remoteProjectionBytes === null ? null : remoteFrameBytes - remoteProjectionBytes, projection })
    return { local, remote }
  }
  owner.ctx.on('agent/pre-step', async ({ agent, step: aStep }, next) => {
    if (agent === a?.agent && aPhase === 'files' && aStep > 1) await wait(`A tool ${aStep - 1}`, () => localReports().length === aStep - 1)
    return next()
  }, { prepend: true })
  owner.ctx.on('llm/stream', (options, next) => {
    const { local } = inspect(a, options, aPhase, 12000)
    if (aPhase === 'peer') {
      const payload = parsed(body(local))
      assert.ok(payload.publications.some(item => item.text === peerReports()[0].text), 'A receives the complete actual B report')
      assert.ok(body(local).includes('B_SHARED_LIVE'))
      assert.ok(!body(local).includes('B_BEFORE_PRIVATE'))
    }
    return next()
  })
  const runA = async phase => {
    aPhase = phase
    owner.adapter.script.push(...(phase === 'files'
      ? [...contents.map((content, index) => write(`budget-a-${index}`, `group-${index + 1}.ts`, content)), reply('A files complete.')]
      : [reply(`A inspected ${phase}.`)]))
    a.agent.followup(createUserMessage({ content: [{ type: 'text', text: `Continue owner responsibility: ${phase}.` }], source: { kind: 'user' } }))
    await a.agent.whenIdle()
    assert.equal(a.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.equal(owner.adapter.script.length, 0)
    if (phase === 'files') for (const [index, content] of contents.entries()) {
      assert.equal(await readFile(join(owner.workspace, `group-${index + 1}.ts`), 'utf8'), content)
    }
  }
  ctx.on('agent/pre-step', async ({ agent, turn: nextTurn, step: nextStep }, next) => {
    turn = nextTurn; step = nextStep
    if (turn === 1 && step === 1) {
      b = await setup(ctx, agent, 'b')
      const aAgent = (await owner.ctx.agents.create({ sessionId: 'budget-owner-existing-session',
        agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: owner.workspace } })).agent
      a = await setup(owner.ctx, aAgent, 'a')
      await runA('baseline')
      await owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.agent.id, expectedCapture: null, taskId: a.task.id,
        bindingId: a.target.taskBindingId, expectedBindingEpoch: a.target.expectedBindingEpoch, roots: [owner.workspace], tools: ['write'], limits })
      await wait('A explicit capture', async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.agent.id })).capture?.collecting)
    } else if (turn === 2 && step === 1) {
      const events = b.agent.session.snapshotEvents()
      const last = events.findLast(event => event.type === 'turn/end')
      b.history = events.filter(event => event.seq <= last.seq)
      assert.equal(await readFile(join(process.cwd(), 'private-before.ts'), 'utf8'), 'export const B_BEFORE_PRIVATE = true;\n')
      const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
      const entry = await owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
        taskId: a.task.id, ownerAddress, expiresAt: limits.expiresAt })
      const status = await ctx.scopeAgentContext.status({ agentId: b.agent.id })
      const requested = await ctx.scopeAgentContributions.request({ agentId: b.agent.id, expectedCapture: null, entry: entry.entry,
        roots: [process.cwd()], tools: ['write'], limits, receive: { expectedReadStateSeq: status.readStateSeq, localTask: b.target } })
      capture = requested.capture
      assert.equal(capture.initialization, undefined)
      await wait('B application', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: a.task.id })).entries[0]?.result.status === 'pending')
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId, expectedProposal: capture.proposal,
        limits, ownerAddress, read: { responsibility: 'Use current owner facts within my existing responsibility.' } })
      await wait('B passive join', async () => (await ctx.scopeAgentContributions.status({ agentId: b.agent.id })).capture?.receiving?.state === 'active')
      binding = state(b).binding
      assert.equal(binding.kind, 'local-task-scope')
      assert.equal(b.requests.length, 2, 'joining does not start an automatic turn')
      assert.equal(peerReports().length, 0, 'ordinary prejoin history is not exported')
      await runA('files')
      rawProjection = (await ctx.scopeAccess.retrieve(binding.subscriptionId, lifetime.signal)).projection
      assert.ok(rawProjection !== undefined)
      assert.ok(Buffer.byteLength(rawProjection.text, 'utf8') > 8000, `owner projection is ${Buffer.byteLength(rawProjection.text, 'utf8')} bytes`)
      assert.equal(parsed(rawProjection.text).publications.filter(item => localReports().some(report => report.id === item.id)).length, 3)
      assert.equal(rawProjection.omittedSources.length, 0)
    } else if (turn === 3 && step === 2) {
      await wait('B live receipt', () => peerReports().length === 1)
      await runA('peer')
    } else if (turn === 4 && step === 1) {
      await ctx.scopeAgentContributions.leaveJoin({ agentId: b.agent.id, expectedCapture: capture.selection })
      await wait('B remote leave', async () => (await ctx.scopeAgentContributions.status({ agentId: b.agent.id })).capture === null
        && state(b).binding?.kind === 'local-task')
      assert.equal((await ctx.scopeAccess.list()).subscriptions.find(item => item.id === binding.subscriptionId).state, 'left')
    }
    await assertLocal()
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const { local, remote } = inspect(b, options, `turn-${turn}-step-${step}`, 8000)
    if (turn === 2 || turn === 3) {
      assert.equal(remote.source.form, 'snapshot', 'the smaller budget must deliver useful context instead of withdrawing it')
      assert.ok(Buffer.byteLength(body(local), 'utf8') <= 4000)
      const projection = remote.source.projection
      const localBytes = Buffer.byteLength(body(local), 'utf8')
      const framingBytes = Buffer.byteLength(body(remote), 'utf8') - Buffer.byteLength(projection.text, 'utf8')
      assert.ok(framingBytes > 0)
      assert.equal(projection.maxContextBytes, 8000 - localBytes - framingBytes,
        'the remote allowance uses actual local text and complete measured framing, without unused local reservation')
      const payload = parsed(projection.text)
      const selected = localReports().filter(report => projection.selectedSources.some(source => source.kind === 'publication' && source.publicationId === report.id))
      assert.ok(selected.length >= 1 && selected.length < 3, 'retain complete useful file groups and explicitly omit those that do not fit')
      for (const report of selected) assert.equal(payload.publications.find(item => item.id === report.id).text, report.text)
      const omitted = projection.omittedSources.filter(item => item.reason === 'budget')
      assert.ok(omitted.length >= 1)
      assert.equal(payload.coverage.budgetOmissions, omitted.length)
      assert.ok(!body(remote).includes('B_BEFORE_PRIVATE') && !body(remote).includes('B_SHARED_LIVE'))
    }
    if (turn === 4) {
      assert.equal(remote.source.form, 'withdrawn')
      assert.ok(!body(remote).includes('OWNER_BUDGET_GROUP_'))
      assert.equal(peerReports().length, 1)
    }
    if (turn === 4 && step === 2) {
      assert.equal(await readFile(join(process.cwd(), 'local-after.ts'), 'utf8'), 'export const B_LOCAL_AFTER_LEAVE = true;\n')
      assert.deepEqual(b.agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name), ['write', 'write', 'write'])
      assert.equal(a.requests.length, 6); assert.equal(b.requests.length, 7)
      for (const item of [a, b]) {
        await item.ctx.sessions.flush(item.agent.session)
        const reader = await item.ctx.sessionPersistence.open(item.agent.id, 'read')
        try {
          const stored = await reader.read()
          assert.deepEqual(stored.events, item.agent.session.snapshotEvents())
          assert.equal(reader.id, item.agent.id)
          assert.deepEqual(reader.header, { ...item.agent.session.header, delegationDepth: item.agent.session.header.delegationDepth ?? 0 })
          assert.deepEqual(contexts(Session.create(reader.id, structuredClone(stored.events), reader.header).deriveMessages()), item.lastContexts)
        } finally { await reader.close() }
      }
      await writeFile(join(process.cwd(), '.dsh/recipient-budget-audit.json'), JSON.stringify({
        hostCount: 2, executingSessionCount: 2, rawProjectionBytes: Buffer.byteLength(rawProjection.text, 'utf8'),
        maxContextBytes: 8000, maxLocalContextBytes: 4000, ownerReports: localReports(),
        members: [a, b].map(item => ({ key: item.key, requests: item.requests, state: state(item) })),
        originalTaskRetained: true, originalHistoryRetained: true, originalToolsRetained: true, localCaptureAbsent: true,
      }))
    }
    yield* next()
  })
}
