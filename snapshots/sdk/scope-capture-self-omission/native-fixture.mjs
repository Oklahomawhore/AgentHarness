/** Exact capture omission through real native Writes and independent Sessions on one source peer. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
export const name = 'scope-capture-self-omission-snapshot'
/** Services supplied by the shipped SDK profile and scenario patches. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm', 'sessions', 'sessionPersistence']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => ['development-task-context', 'scope-agent-context'].includes(message.source.kind))
const marker = { b: 'B_OWN_REPORT_', c1: 'C1_INDEPENDENT_REPORT', c2: 'C2_SAME_PEER_OTHER_SESSION', continued: 'C2_AFTER_B_LEFT' }
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (id, path, content) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: JSON.stringify({ file_path: path, content }) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]
/** Exercise public consent and management services; only successful production tools publish facts. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('capture omission fixture disposed')))
  const wait = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`capture omission did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const owner = await host(join(process.cwd(), '.dsh/capture-owner'), 'owner')
  ctx.effect(() => owner.close)
  const c = await host(join(process.cwd(), '.dsh/capture-c'), 'c')
  ctx.effect(() => c.close)
  await owner.ctx.developmentRooms.announce({ id: 'capture-owner', kind: 'human', displayName: 'Shared goal owner' })
  const shared = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'capture-owner',
    objective: 'Integrate independent implementation reports.', scope: 'Each Session keeps its own local responsibility.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  const entry = await owner.ctx.scopeAccess.createGroupEntry({ taskId: shared.id, ownerAddress, expiresAt: limits.expiresAt, maxMembers: 3 })
  const root = join(process.cwd(), 'project')
  await mkdir(root, { recursive: true })
  const state = (context, agent) => context.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
  const localReports = item => item.ctx.developmentTasks.get({ taskId: item.task.id }).context.filter(report => report.localToolObservation !== undefined)
  const reports = () => owner.ctx.developmentTasks.get({ taskId: shared.id }).context.filter(report => report.peerToolObservation !== undefined)
  const reportsFor = item => reports().filter(report => report.peerContribution.grant.captureId === item.remote.selection.captureId)
  const setup = async (context, agent, key, directory) => {
    const participantId = developmentAgentParticipantId(agent.id)
    await context.developmentRooms.announce({ id: `capture-${key}-human`, kind: 'human', displayName: `Person ${key}` })
    await context.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: `Existing ${key} Session` })
    const task = await context.developmentTasks.create({ origin: { kind: 'root' }, createdBy: `capture-${key}-human`,
      objective: `Preserve ${key} local responsibility.`, scope: `Only ${key} approved file work may be shared.` })
    const bindingId = `capture-${key}-local-binding`
    await context.developmentTasks.checkout({ taskId: task.id, participantId, bindingId })
    const epoch = context.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
    const target = { taskId: task.id, taskBindingId: bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
    await context.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, taskId: task.id,
      bindingId, expectedBindingEpoch: target.expectedBindingEpoch, roots: [directory], tools: ['write'], limits })
    await wait(`${key} local capture`, async () => (await context.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
    const original = await context.scopeAgentContributions.localStatus({ agentId: agent.id })
    await context.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
    return { ctx: context, agent, key, directory, task, target, original, remote: undefined, requests: [], history: undefined }
  }
  const joinMember = async item => {
    const status = await item.ctx.scopeAgentContext.status({ agentId: item.agent.id })
    const requested = await item.ctx.scopeAgentContributions.request({ agentId: item.agent.id, expectedCapture: null,
      entry: entry.entry, roots: [item.directory], tools: ['write'], limits,
      receive: { expectedReadStateSeq: status.readStateSeq, localTask: item.target } })
    let application
    await wait(`${item.key} pending`, async () => {
      application = (await owner.ctx.scopeAccess.groupApplications({ entryId: entry.entry.entryId })).entries
        .find(candidate => candidate.proposal.captureId === requested.capture.selection.captureId)
      return application?.result.status === 'pending'
    })
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      applicationId: application.applicationId, expectedProposal: requested.capture.proposal, limits, ownerAddress,
      read: { responsibility: `Use independent changes for ${item.key} responsibility.` } })
    await wait(`${item.key} receiving`, async () => {
      const capture = (await item.ctx.scopeAgentContributions.status({ agentId: item.agent.id })).capture
      return capture?.collecting && capture.receiving?.state === 'active'
    })
    item.remote = (await item.ctx.scopeAgentContributions.status({ agentId: item.agent.id })).capture
    item.binding = state(item.ctx, item.agent).binding
    assert.equal(item.binding.kind, 'local-task-scope')
    assert.equal(state(item.ctx, item.agent).automatic, null)
  }
  const assertLocal = async item => {
    const local = await item.ctx.scopeAgentContributions.localStatus({ agentId: item.agent.id })
    assert.deepEqual(local.assignment, item.original.assignment)
    assert.deepEqual(local.capture.selection, item.original.capture.selection)
    assert.equal(local.capture.collecting, true)
    assert.equal(item.ctx.agents.get(item.agent.id), item.agent)
  }
  const assertRequest = (item, options, phase) => {
    const visible = contexts(options.messages)
    item.lastContexts = visible
    const local = visible.find(message => message.source.kind === 'development-task-context')
    const remote = visible.find(message => message.source.kind === 'scope-agent-context')
    assert.equal(local.source.projection.taskId, item.task.id)
    assert.deepEqual(local.source.projection.bindingEpoch, item.target.expectedBindingEpoch)
    const bytes = Buffer.byteLength(visible.map(body).join(''), 'utf8')
    assert.ok(bytes <= 8000, 'full local text plus remote framing and metadata share the same byte cap')
    const copy = Session.create(item.agent.id, structuredClone(item.agent.session.snapshotEvents()), item.agent.session.header)
    assert.deepEqual(contexts(copy.deriveMessages()), visible)
    if (item.history !== undefined) assert.deepEqual(item.agent.session.snapshotEvents().slice(0, item.history.length), item.history)
    assert.equal(state(item.ctx, item.agent).usedBudget, 0)
    const audit = { phase, bytes, remoteText: remote === undefined ? null : body(remote),
      remoteForm: remote?.source.form, projection: remote?.source.form === 'snapshot' ? remote.source.projection : null }
    item.requests.push(audit)
    if (remote?.source.form === 'snapshot') {
      assert.equal(remote.source.projection.version, 3)
      assert.deepEqual(remote.source.projection.peerCapture, {
        ownerPeerId: item.remote.invitation.grant.ownerPeerId, contributorPeerId: item.remote.proposal.contributorPeerId,
        taskId: shared.id, grantId: item.remote.invitation.grant.grantId, generation: item.remote.invitation.grant.generation,
        captureId: item.remote.selection.captureId, captureGeneration: item.remote.selection.captureGeneration,
      })
      const own = marker[item.key]
      assert.ok(!body(remote).includes(own), `${item.key} receives no ordinary report from its exact capture`)
      if (reportsFor(item).length > 0 && !['stopped', 'withdrawn'].includes(phase)) {
        assert.ok(remote.source.projection.omittedSources.some(source => source.reason === 'self-published'))
      }
    }
    return remote
  }
  let b
  let c1
  let c2
  let cCurrent
  let cPhase
  let turn = 0
  let step = 0
  let applications
  c.ctx.on('llm/stream', (options, next) => {
    assertRequest(cCurrent, options, cPhase)
    return next()
  })
  const runC = async (item, phase, content) => {
    cCurrent = item; cPhase = phase
    const beforeLocal = localReports(item).length
    const beforeRemote = item.remote === undefined ? 0 : reportsFor(item).length
    if (content === undefined) c.adapter.script.push(reply(`${item.key} inspected ${phase}.`))
    else c.adapter.script.push(tool(`capture-${item.key}-${phase}`, `${item.key}-${phase}.ts`, content), reply(`${item.key} saved ${phase}.`))
    item.agent.followup(createUserMessage({ content: [{ type: 'text', text: `Continue ${item.key} responsibility: ${phase}.` }], source: { kind: 'user' } }))
    await item.agent.whenIdle()
    assert.equal(item.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    if (content !== undefined) {
      assert.equal(await readFile(join(c.workspace, `${item.key}-${phase}.ts`), 'utf8'), content)
      await wait(`${item.key} ${phase} tool publications`, () => localReports(item).length === beforeLocal + 1
        && (item.remote === undefined || reportsFor(item).length === beforeRemote + 1))
    }
    await assertLocal(item)
  }
  ctx.on('agent/pre-step', async ({ agent, turn: nextTurn, step: nextStep }, next) => {
    turn = nextTurn; step = nextStep
    if (turn === 1 && step === 1) {
      b = await setup(ctx, agent, 'b', root)
      const create = async key => (await c.ctx.agents.create({ sessionId: `capture-${key}-existing-session`,
        agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: c.workspace } })).agent
      c1 = await setup(c.ctx, await create('c1'), 'c1', c.workspace)
      c2 = await setup(c.ctx, await create('c2'), 'c2', c.workspace)
      await runC(c1, 'baseline', 'export const C1_BASELINE = true;\n')
      await runC(c2, 'baseline', 'export const C2_BASELINE = true;\n')
      c1.history = c1.agent.session.snapshotEvents(); c2.history = c2.agent.session.snapshotEvents()
    } else if (turn === 1 && step === 2) {
      await wait('B baseline', () => localReports(b).length === 1)
    } else if (turn === 2 && step === 1) {
      b.history = b.agent.session.snapshotEvents().filter(event => event.seq <= b.agent.session.snapshotEvents()
        .findLast(candidate => candidate.type === 'turn/end').seq)
      for (const item of [b, c1, c2]) await joinMember(item)
      assert.equal(c1.remote.proposal.contributorPeerId, c2.remote.proposal.contributorPeerId)
      assert.notEqual(c1.remote.selection.captureId, c2.remote.selection.captureId)
      assert.notEqual(c1.remote.selection.captureGeneration, c2.remote.selection.captureGeneration)
      await runC(c1, 'shared', `export const C1 = '${marker.c1}';\n`)
      await runC(c2, 'shared', `export const C2 = '${marker.c2}';\n`)
    } else if (turn === 2 && step === 2) {
      await wait('B dual report', () => localReports(b).length === 2 && reportsFor(b).length === 1)
      assert.ok(reportsFor(b)[0].text.includes(marker.b), 'owner retains the original large multibyte source')
      assert.equal(reports().length, 3)
    } else if (turn === 3 && step === 1) {
      await runC(c1, 'cross-read')
      await runC(c2, 'cross-read')
      assert.ok(c1.requests.at(-1).remoteText.includes(marker.c2), 'same peer, different Session must remain visible')
      assert.ok(c1.requests.at(-1).remoteText.includes(marker.b))
      assert.ok(c2.requests.at(-1).remoteText.includes(marker.c1))
      assert.ok(c2.requests.at(-1).remoteText.includes(marker.b))
    } else if (turn === 4 && step === 1) {
      await ctx.scopeAgentContributions.stop({ agentId: b.agent.id, expectedCapture: b.remote.selection })
      await wait('B remote stop', async () => (await ctx.scopeAgentContributions.status({ agentId: b.agent.id })).capture === null)
      assert.equal(state(ctx, b.agent).binding.id, b.binding.id, 'stop retains adopted receiving')
      await runC(c1, 'withdrawn')
      assert.ok(!c1.requests.at(-1).remoteText.includes(marker.b))
      assert.ok(c1.requests.at(-1).projection.omittedSources.some(source => source.reason === 'withdrawn'))
      assert.ok(c1.requests.at(-1).remoteText.includes(marker.c2))
    } else if (turn === 5 && step === 1) {
      await ctx.scopeAgentContext.leave({ agentId: b.agent.id, expectedBindingId: b.binding.id })
      await wait('B local-only binding', () => state(ctx, b.agent).binding?.kind === 'local-task')
      const ended = (await ctx.scopeAccess.list()).subscriptions.find(item => item.id === b.binding.subscriptionId)
      assert.equal(ended.state, 'left')
      await runC(c2, 'continued', `export const C2_CONTINUED = '${marker.continued}';\n`)
      await runC(c1, 'continued-read')
      assert.ok(c1.requests.at(-1).remoteText.includes(marker.continued))
      applications = (await owner.ctx.scopeAccess.groupApplications({ entryId: entry.entry.entryId })).entries
      assert.equal(applications.find(item => item.proposal.captureId === b.remote.selection.captureId).result.readState, 'active')
      assert.ok([c1, c2].every(item => applications.find(candidate => candidate.proposal.captureId === item.remote.selection.captureId).result.status === 'approved'))
    } else if (turn === 5 && step === 2) {
      await wait('B final local Write', () => localReports(b).length === 3)
      assert.equal(reportsFor(b).length, 1)
      assert.equal(await readFile(join(root, 'final.ts'), 'utf8'), 'export const B_LOCAL_FINAL = true;\n')
    }
    await assertLocal(b)
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const phase = turn === 4 ? 'stopped' : turn === 5 ? 'left' : `turn-${turn}-step-${step}`
    const remote = assertRequest(b, options, phase)
    if (turn >= 2 && turn <= 4) {
      assert.equal(remote.source.form, 'snapshot')
      assert.ok(body(remote).includes(marker.c1))
      assert.ok(body(remote).includes(marker.c2))
      if (turn === 4) assert.ok(remote.source.projection.omittedSources.some(source => source.reason === 'withdrawn'))
    } else if (turn === 5) {
      assert.equal(remote.source.form, 'withdrawn')
      assert.ok(!body(remote).includes(marker.c1) && !body(remote).includes(marker.c2))
      assert.equal(state(ctx, b.agent).mode, 'passive')
    }
    if (turn === 5 && step === 2) {
      for (const item of [b, c1, c2]) {
        await item.ctx.sessions.flush(item.agent.session)
        const handle = await item.ctx.sessionPersistence.open(item.agent.id, 'read')
        try {
          const stored = await handle.read()
          assert.deepEqual(stored.events, item.agent.session.snapshotEvents())
          assert.deepEqual(contexts(Session.create(item.agent.id, structuredClone(stored.events), item.agent.session.header).deriveMessages()),
            item.lastContexts, 'both contexts reconstruct from actual disk events')
        } finally { await handle.close() }
        assert.equal(item.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
          && event.data.source.kind === 'scope-agent-pulse').length, 0)
      }
      assert.equal(b.requests.length, 8)
      assert.equal(c1.requests.length, 7)
      assert.equal(c2.requests.length, 7)
      await writeFile(join(process.cwd(), '.dsh/capture-self-audit.json'), JSON.stringify({
        entry: entry.entry, applications, ownerPublications: owner.ctx.developmentTasks.get({ taskId: shared.id }).context,
        members: [b, c1, c2].map(item => ({ key: item.key, peerId: item.remote.proposal.contributorPeerId,
          capture: item.remote.selection, localTaskId: item.task.id, requests: item.requests,
          state: state(item.ctx, item.agent), localCapture: item.original.capture.selection })),
      }))
    }
    yield* next()
  })
}
