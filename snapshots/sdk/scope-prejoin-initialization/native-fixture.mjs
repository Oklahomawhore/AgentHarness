/** Existing local tool observations initialize an explicitly approved peer capture without reading files again. */
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
const { symbols } = await load('@deepseek-ai/cordis')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-prejoin-initialization-snapshot'
/** Services provided by the shipped SDK profile and explicit scenario patches. */
export const inject = ['fs', 'agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm', 'sessions', 'sessionPersistence']
const maxContextBytes = 12000
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => ['development-task-context', 'scope-agent-context'].includes(message.source.kind))
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const write = (id, path, content) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: JSON.stringify({ file_path: path, content }) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]
/** Drive independent real Hosts; model scripts produce real tool completions, never fabricated observations. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('history initialization fixture disposed')))
  const wait = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`history initialization did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const owner = await host(join(process.cwd(), '.dsh/history-owner'), 'owner')
  ctx.effect(() => owner.close)
  const c = await host(join(process.cwd(), '.dsh/history-c'), 'c', { maxContextBytes })
  ctx.effect(() => c.close)
  await owner.ctx.developmentRooms.announce({ id: 'history-owner', kind: 'human', displayName: 'Shared goal owner' })
  const shared = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'history-owner',
    objective: 'Use approved recorded work and subsequent changes.', scope: 'Retain each person’s existing local responsibility.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 16, maxSampleBytes: 8192 }
  const entry = await owner.ctx.scopeAccess.createGroupEntry({ taskId: shared.id, ownerAddress, expiresAt: limits.expiresAt, maxMembers: 2 })
  const allowed = join(process.cwd(), 'project')
  const privateRoot = join(process.cwd(), 'private')
  await mkdir(allowed, { recursive: true }); await mkdir(privateRoot, { recursive: true })
  const state = item => item.ctx.sessionProjections.stateOf(item.agent.session, 'scopeAgentContext')
  const localReports = item => item.ctx.developmentTasks.get({ taskId: item.task.id }).context.filter(report => report.localToolObservation !== undefined)
  const reports = () => owner.ctx.developmentTasks.get({ taskId: shared.id }).context.filter(report => report.peerToolObservation !== undefined)
  const reportsFor = item => reports().filter(report => report.peerContribution.grant.captureId === item.remote.selection.captureId)
  const setup = async (context, agent, key, roots, directory) => {
    const participantId = developmentAgentParticipantId(agent.id)
    await context.developmentRooms.announce({ id: `history-${key}-human`, kind: 'human', displayName: `Person ${key}` })
    await context.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: `Existing ${key} Session` })
    const task = await context.developmentTasks.create({ origin: { kind: 'root' }, createdBy: `history-${key}-human`,
      objective: `Retain ${key} local responsibility.`, scope: `Only approved ${key} work may leave its local goal.` })
    const bindingId = `history-${key}-local-binding`
    await context.developmentTasks.checkout({ taskId: task.id, participantId, bindingId })
    const epoch = context.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
    const target = { taskId: task.id, taskBindingId: bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
    await context.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, taskId: task.id,
      bindingId, expectedBindingEpoch: target.expectedBindingEpoch, roots, tools: ['write', 'edit'], limits })
    await wait(`${key} local capture`, async () => (await context.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
    const original = await context.scopeAgentContributions.localStatus({ agentId: agent.id })
    await context.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
    return { ctx: context, agent, key, directory, task, target, original, remote: undefined, requests: [], history: undefined }
  }
  const requestJoin = async (item, history) => {
    const status = await item.ctx.scopeAgentContext.status({ agentId: item.agent.id })
    const local = await item.ctx.scopeAgentContributions.localStatus({ agentId: item.agent.id })
    const request = { agentId: item.agent.id, expectedCapture: null, entry: entry.entry, roots: [item.directory],
      tools: ['write', 'edit'], limits, receive: { expectedReadStateSeq: status.readStateSeq, localTask: item.target },
      ...(history ? { initialization: { kind: 'recorded-local-tools', expectedLocalCapture: local.capture.selection,
        localTask: local.assignment } } : {}) }
    const requested = await item.ctx.scopeAgentContributions.request(request)
    item.remote = requested.capture
    assert.equal(requested.capture.initialization?.state, history ? 'pending' : undefined)
    await wait(`${item.key} application`, async () => {
      item.application = (await owner.ctx.scopeAccess.groupApplications({ entryId: entry.entry.entryId })).entries
        .find(candidate => candidate.proposal.captureId === requested.capture.selection.captureId)
      return item.application?.result.status === 'pending'
    })
    assert.equal(item.application.proposal.source.initialization, history ? 'recorded-local-tools' : undefined)
  }
  const approve = async item => {
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      applicationId: item.application.applicationId, expectedProposal: item.remote.proposal, limits, ownerAddress,
      read: { responsibility: `Use approved observations for ${item.key} responsibility.` } })
    await wait(`${item.key} receiving`, async () => {
      const capture = (await item.ctx.scopeAgentContributions.status({ agentId: item.agent.id })).capture
      return capture?.collecting && capture.receiving?.state === 'active'
    })
    item.remote = (await item.ctx.scopeAgentContributions.status({ agentId: item.agent.id })).capture
    item.binding = state(item).binding
    assert.equal(item.binding.kind, 'local-task-scope')
    assert.equal(state(item).automatic, null)
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
    assert.ok(bytes <= maxContextBytes, 'local plus framed remote context share the configured byte allowance')
    assert.deepEqual(contexts(Session.create(item.agent.id, structuredClone(item.agent.session.snapshotEvents()), item.agent.session.header).deriveMessages()), visible)
    if (item.history !== undefined) assert.deepEqual(item.agent.session.snapshotEvents().slice(0, item.history.length), item.history)
    assert.equal(state(item).usedBudget, 0)
    item.requests.push({ phase, bytes, remoteText: remote === undefined ? null : body(remote), remoteForm: remote?.source.form,
      projection: remote?.source.form === 'snapshot' ? remote.source.projection : null })
    if (remote?.source.form === 'snapshot') {
      assert.equal(remote.source.projection.version, 3)
      assert.equal(remote.source.projection.peerCapture.captureId, item.remote.selection.captureId)
      assert.ok(!body(remote).includes('B_PRIVATE_NOT_SHARED') && !body(remote).includes('C_PREJOIN_NOT_CONSENTED'))
      assert.ok(!body(remote).includes('DISK_ONLY_UNRECORDED'), 'initialization uses recorded observations, not present file contents')
      if (item.key === 'b') for (const publication of reportsFor(item)) {
        assert.ok(!remote.source.projection.selectedSources.some(source => source.kind === 'publication'
          && source.publicationId === publication.id), 'all exact own reports, including failed edits, are omitted')
        const omitted = remote.source.projection.omittedSources.find(source => source.source.kind === 'publication'
          && source.source.publicationId === publication.id)
        assert.ok(omitted !== undefined)
        if (!['superseded', 'withdrawn'].includes(omitted.reason)) assert.equal(omitted.reason, 'self-published')
      }
      if (item.key === 'b') for (const own of ['B_RECORDED_V1', 'B_RECORDED_V2', 'B_BEFORE_APPROVAL', 'B_LIVE_LATEST']) {
        assert.ok(!body(remote).includes(own), 'the associated capture omits its own history and live ordinary reports')
      }
    }
    return remote
  }
  let b
  let memberC
  let cPhase
  let cToolCompletion
  let turn = 0
  let step = 0
  let frozen
  let initializedReports
  let fileOperations = []
  c.ctx.on('llm/stream', (options, next) => { assertRequest(memberC, options, cPhase); return next() })
  c.ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    if (agent === memberC?.agent && step === 2 && cToolCompletion !== undefined) {
      await wait(`C ${cPhase} recorded tool completion`, () => localReports(memberC).length === cToolCompletion.local
        && (cToolCompletion.remote === undefined || reportsFor(memberC).length === cToolCompletion.remote))
    }
    return next()
  }, { prepend: true })
  const runC = async (phase, content) => {
    cPhase = phase
    const before = localReports(memberC).length
    cToolCompletion = content === undefined ? undefined : { local: before + 1,
      remote: memberC.remote === undefined ? undefined : reportsFor(memberC).length + 1 }
    c.adapter.script.push(...(content === undefined ? [reply(`C inspected ${phase}.`)]
      : [write(`history-c-${phase}`, `c-${phase}.ts`, content), reply(`C saved ${phase}.`)]))
    memberC.agent.followup(createUserMessage({ content: [{ type: 'text', text: `Continue C responsibility: ${phase}.` }], source: { kind: 'user' } }))
    await memberC.agent.whenIdle()
    assert.equal(memberC.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    if (content !== undefined) {
      assert.equal(await readFile(join(c.workspace, `c-${phase}.ts`), 'utf8'), content)
      await wait(`C ${phase} local report`, () => localReports(memberC).length === before + 1)
    }
    await assertLocal(memberC)
  }
  ctx.on('agent/pre-step', async ({ agent, turn: nextTurn, step: nextStep }, next) => {
    turn = nextTurn; step = nextStep
    if (turn === 1 && step >= 2 && step <= 5) {
      await wait(`B first-turn tool completion ${step - 1}`, () => localReports(b).length === step - 1)
    } else if (turn === 2 && step === 2) {
      await wait('B pending-approval tool completion', () => localReports(b).length === 5)
    }
    if (turn === 1 && step === 1) {
      b = await setup(ctx, agent, 'b', [privateRoot, allowed], allowed)
      const cAgent = (await c.ctx.agents.create({ sessionId: 'history-c-existing-session',
        agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: c.workspace } })).agent
      memberC = await setup(c.ctx, cAgent, 'c', [c.workspace], c.workspace)
      await runC('baseline', 'export const C_PREJOIN_NOT_CONSENTED = true;\n')
      memberC.history = memberC.agent.session.snapshotEvents()
    } else if (turn === 2 && step === 1) {
      await wait('B four local records', () => localReports(b).length === 4)
      b.history = b.agent.session.snapshotEvents().filter(event => event.seq <= b.agent.session.snapshotEvents()
        .findLast(candidate => candidate.type === 'turn/end').seq)
      await requestJoin(memberC, false); await approve(memberC)
      assert.equal(reportsFor(memberC).length, 0, 'joining alone exports no prejoin observations')
      await requestJoin(b, true)
    } else if (turn === 3 && step === 1) {
      await wait('B pending local record', () => localReports(b).length === 5)
      assert.equal(reportsFor(b).length, 0)
      await writeFile(join(allowed, 'shared.ts'), 'export const DISK_ONLY_UNRECORDED = true;\n')
      const fs = b.agent.ctx.get('fs')
      assert.ok(fs !== undefined, 'the original Agent must retain its active filesystem')
      assert.equal(fs[symbols.original] ?? fs, ctx.fs[symbols.original] ?? ctx.fs,
        'instrument the same filesystem provider used by this source Agent and the injected fixture')
      const originals = new Map()
      for (const method of ['readText', 'readBytes', 'readByteRange', 'streamText', 'listDir', 'writeText', 'editText']) {
        if (typeof fs[method] !== 'function') continue
        originals.set(method, fs[method])
        fs[method] = function (...args) { fileOperations.push(method); return originals.get(method).apply(this, args) }
      }
      try {
        await approve(b)
        await wait('four historical receipts', async () => {
          frozen = (await ctx.scopeAgentContributions.status({ agentId: b.agent.id })).capture.initialization
          return frozen.state === 'frozen' && frozen.coverage.acknowledged === 4
        })
      } finally { for (const [method, original] of originals) fs[method] = original }
      assert.deepEqual(fileOperations, [], 'history initialization does not read, list, or mutate file contents')
      assert.deepEqual(frozen.coverage, { recorded: 5, selected: 4, omitted: 1, unconfirmed: 0, inFlight: 0, acknowledged: 4 })
      initializedReports = reportsFor(b)
      assert.equal(initializedReports.length, 4)
      const observations = initializedReports.map(report => report.peerToolObservation)
      assert.deepEqual(observations.map(report => [report.tool, report.reportedStatus]),
        [['Write', 'success'], ['Edit', 'success'], ['Edit', 'failure'], ['Write', 'success']])
      assert.ok(observations.every(report => report.version === 2 && report.fields.rootIndex === 0))
      assert.equal(new Set(observations.map(report => report.origin.executionDigest)).size, 4)
      assert.ok(initializedReports.every(report => !report.text.includes('B_PRIVATE_NOT_SHARED') && !report.text.includes('DISK_ONLY_UNRECORDED')))
      assert.equal(await readFile(join(allowed, 'shared.ts'), 'utf8'), 'export const DISK_ONLY_UNRECORDED = true;\n')
      await runC('historical')
      const historicalRequest = memberC.requests.at(-1)
      const historical = historicalRequest.remoteText
      const requiredMarkers = ['B_RECORDED_V2', 'B_BEFORE_APPROVAL', 'failure']
      const missing = requiredMarkers.filter(marker => !historical.includes(marker))
      const diagnostic = {
        phase: historicalRequest.phase, fullContextBytes: historicalRequest.bytes,
        remoteFrameBytes: Buffer.byteLength(historical, 'utf8'), missing,
        remoteForm: historicalRequest.remoteForm, selectedSources: historicalRequest.projection?.selectedSources,
        omittedSources: historicalRequest.projection?.omittedSources,
        ownerReports: initializedReports.map(report => ({ id: report.id, tool: report.peerToolObservation.tool,
          path: report.peerToolObservation.fields.path, reportedStatus: report.peerToolObservation.reportedStatus,
          reportBytes: Buffer.byteLength(report.text, 'utf8') })), remoteText: historical,
      }
      assert.deepEqual(missing, [], `C must receive the permitted historical chain and pending-approval Write: ${JSON.stringify(diagnostic)}`)
    } else if (turn === 4 && step === 3) {
      await wait('B live contribution', () => reportsFor(b).length === 5 && localReports(b).length === 6)
      assert.equal(reportsFor(b).at(-1).peerToolObservation.version, 1)
      assert.equal(reportsFor(b).at(-1).peerToolObservation.origin, undefined)
      assert.deepEqual((await ctx.scopeAgentContributions.status({ agentId: b.agent.id })).capture.initialization, frozen)
      await runC('latest')
      const latest = memberC.requests.at(-1)
      assert.ok(latest.remoteText.includes('B_LIVE_LATEST'))
      assert.ok(!latest.remoteText.includes('B_RECORDED_V2'))
      for (const report of initializedReports.filter(item => item.peerToolObservation.fields.path === 'shared.ts')) {
        assert.ok(latest.projection.omittedSources.some(item => item.reason === 'superseded'
          && item.source.kind === 'publication' && item.source.publicationId === report.id))
      }
      assert.deepEqual(reportsFor(b).slice(0, 4), initializedReports)
    } else if (turn === 5 && step === 1) {
      await runC('live', 'export const C_LIVE_APPROVED = true;\n')
      await wait('C live contribution', () => reportsFor(memberC).length === 1)
      assert.equal(reportsFor(memberC)[0].peerToolObservation.version, 1)
    } else if (turn === 6 && step === 1) {
      await ctx.scopeAgentContributions.leaveJoin({ agentId: b.agent.id, expectedCapture: b.remote.selection })
      await wait('B left remote', async () => (await ctx.scopeAgentContributions.status({ agentId: b.agent.id })).capture === null
        && state(b).binding?.kind === 'local-task')
      assert.equal((await ctx.scopeAccess.list()).subscriptions.find(item => item.id === b.binding.subscriptionId).state, 'left')
      await runC('withdrawn')
      assert.ok(!memberC.requests.at(-1).remoteText.includes('B_LIVE_LATEST'))
      assert.ok(memberC.requests.at(-1).projection.omittedSources.some(source => source.reason === 'withdrawn'))
      await runC('continued', 'export const C_AFTER_B_LEAVES = true;\n')
      await wait('C independent continuation', () => reportsFor(memberC).length === 2)
    } else if (turn === 6 && step === 2) {
      await wait('B retained local work', () => localReports(b).length === 7)
      assert.equal(reportsFor(b).length, 5)
    }
    await assertLocal(b)
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const remote = assertRequest(b, options, `turn-${turn}-step-${step}`)
    if (turn === 5) assert.ok(body(remote).includes('C_LIVE_APPROVED'))
    if (turn === 6) { assert.equal(remote.source.form, 'withdrawn'); assert.ok(!body(remote).includes('C_LIVE_APPROVED')) }
    if (turn === 6 && step === 2) {
      for (const item of [b, memberC]) {
        await item.ctx.sessions.flush(item.agent.session)
        const reader = await item.ctx.sessionPersistence.open(item.agent.id, 'read')
        try {
          const stored = await reader.read()
          assert.deepEqual(stored.events, item.agent.session.snapshotEvents())
          assert.equal(reader.id, item.agent.id)
          assert.deepEqual(reader.header, { ...item.agent.session.header,
            delegationDepth: item.agent.session.header.delegationDepth ?? 0 })
          assert.deepEqual(contexts(Session.create(reader.id, structuredClone(stored.events), reader.header).deriveMessages()), item.lastContexts)
        } finally { await reader.close() }
      }
      await writeFile(join(process.cwd(), '.dsh/prejoin-initialization-audit.json'), JSON.stringify({
        hostCount: 3, executingSessionCount: 2, initialization: frozen, initializedReports, fileOperations,
        ownerPublications: owner.ctx.developmentTasks.get({ taskId: shared.id }).context,
        members: [b, memberC].map(item => ({ key: item.key, capture: item.remote.selection,
          localTaskId: item.task.id, requests: item.requests, state: state(item), localCapture: item.original.capture.selection })),
      }))
    }
    yield* next()
  })
}
