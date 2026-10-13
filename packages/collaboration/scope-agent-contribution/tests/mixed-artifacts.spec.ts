/** Independent policy, QA, and command-evidence artifacts from fixed-budget mixed work; no external model is used. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, type TestContext } from 'vitest'
import { parsePolicy, sealDataArtifact } from '../../../../scripts/scope-evaluation/data-artifacts.ts'
import { createMixedStudy, gradeMixedArtifacts, mixedStudyConditions, parseMixedStudyConfig,
  parseMixedVerification, type MixedStudyCondition } from '../../../../scripts/scope-evaluation/mixed-study.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'
import { mixedArtifactReplies, MixedArtifactSummaryAdapter, mixedVisibleEvidence } from './fixtures/mixed-artifact-adapter.ts'

const route = { provider: 'deepseek-official', endpointSource: { kind: 'openai-compatible-gateway', name: 'keyless-calibration' },
  network: { kind: 'direct' }, model: 'controlled', endpoint: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED_CALIBRATION_KEY',
  credentialsPath: null, maxCalls: 8, maxInputBytes: 131072, maxOutputTokens: 2048, maxOutputBytes: 65536, timeoutMs: 10000 }
const config = parseMixedStudyConfig({ ordinary: route, semantic: { ...route, maxCalls: 2 }, limits: {
  contextBytes: 8000, maxArtifactBytes: 65536, wallTimeoutMs: 300000, cleanupTimeoutMs: 10000, operationTimeoutMs: 30000,
} }, 'transport-calibration')
const summaryConfig = { auditSessionId: 'mixed-artifact-summary', provider: 'mixed-summary', model: 'controlled-summary',
  maxInputBytes: 64000, maxOutputTokens: 2048, maxOutputBytes: 16000, timeoutMs: 10000, maxConcurrentCalls: 2, maxCalls: 2 }
const privateMarker = 'MIXED_PRIVATE_CHECK_IMPLEMENTATION'
const checkSource = `// ${privateMarker}\nconst state=JSON.parse(require("node:fs").readFileSync("check-state.json","utf8"));\n`
  + 'process.stdout.write(state.output);process.exit(state.code);\n'
type Role = 'B' | 'C'
type Phase = 'original' | 'mixed' | 'left'

function bytes(messages: GenerateOptions['messages']) {
  return messages.flatMap(message => message.content)
    .reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
}

async function calibrate(condition: MixedStudyCondition, test: TestContext) {
  const { runtime, oracle } = createMixedStudy(20261008, config)
  const hosts: TestHost[] = []
  const closed: { peerId: string; settled: boolean; exitCodes: readonly number[] }[] = []
  let temporaryOutput: string | undefined
  const close = async () => {
    const failures: unknown[] = []
    for (const host of hosts.splice(0).reverse()) {
      try { await host.close(); closed.push({ peerId: host.peerId, settled: true, exitCodes: [...host.exitCodes] }) }
      catch (error) { failures.push(error) }
    }
    if (failures.length !== 0) throw new AggregateError(failures, 'Mixed artifact Hosts did not settle')
  }
  onTestFinished(async () => {
    try { await close() } finally {
      if (temporaryOutput !== undefined) await rm(temporaryOutput, { recursive: true, force: true })
    }
  })
  const polling = { timeout: test.task.timeout }
  const network = new TestNetwork()
  const summaryAdapter = new MixedArtifactSummaryAdapter()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: true,
    contextBackend: condition === 'semantic' ? 'semantic' : 'reported',
    ...(condition === 'semantic' ? { semantic: { config: summaryConfig, adapter: summaryAdapter } } : {}) })
  hosts.push(owner)
  const peer = await createHost(network, 'source')
  hosts.push(peer)
  const task = await rootTask(owner)
  const author = await owner.createAgent('mixed-api-author')
  const documentAuthor = await peer.createAgent('mixed-document-author')
  const authorParticipant = developmentAgentParticipantId(author.id)
  await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(value => value.id === authorParticipant), polling).toBe(true)
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId: authorParticipant,
    sessionLabel: 'Maintain the payment API policy and its verification command.' })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })
  if (local.assignment === null) throw new Error('Source responsibility missing')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 24, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: author.id, expectedCapture: null, ...local.assignment,
    roots: [owner.workspace], tools: ['write', 'edit'], commands: [{ command: runtime.source.command, rootIndex: 0 }], limits })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address missing')
  const entry = (await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: limits.expiresAt })).entry
  const request = await peer.ctx.scopeAgentContributions.request({ agentId: documentAuthor.id, expectedCapture: null, entry,
    roots: [peer.workspace], tools: ['write'], limits })
  if (request.capture === null) throw new Error('Document capture missing')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id }))
    .entries.find(value => value.entry.entryId === entry.entryId)?.result.status, polling).toBe('pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
    expectedProposal: request.capture.proposal, limits, ownerAddress })
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })).capture?.collecting,
    polling).toBe(true)
  await expect.poll(async () => (await peer.ctx.scopeAgentContributions.status({ agentId: documentAuthor.id })).capture?.collecting,
    polling).toBe(true)

  const requests: { role: Role
    phase: Phase
    messages: GenerateOptions['messages']
    events: readonly SessionEvent[]
    disk: readonly SessionEvent[]
    diskHeader: unknown
    managedBytes: number
    localBytes: number
    sharedBytes: number
    framingBytes: number
    visibleExitCode: number | null
    visiblePolicyCorrection: boolean }[] = []
  let phase: Phase = 'original'
  const receivers = []
  for (const role of ['B', 'C'] as const) {
    const host = await createHost(network, 'receiver', 'native', { ownerLocal: true, contextBackend: 'reported', maxContextBytes: 8000 })
    hosts.push(host)
    const project = runtime.roles[role]
    for (const [path, content] of Object.entries(project.initialFiles)) {
      await mkdir(dirname(join(host.workspace, path)), { recursive: true })
      await writeFile(join(host.workspace, path), content, { flag: 'wx' })
    }
    const agent = await host.createAgent(`mixed-${role.toLowerCase()}`)
    const ownTask = await rootTask(host)
    const participantId = developmentAgentParticipantId(agent.id)
    const responsibility = role === 'B' ? 'Maintain the payment client policy and preserve complete request bodies.'
      : 'Maintain payment QA cases for retry boundaries, non-retry errors, and observed verification failures.'
    await expect.poll(() => host.ctx.developmentRooms.list().participants.some(value => value.id === participantId), polling).toBe(true)
    await host.ctx.developmentTasks.checkout({ taskId: ownTask.id, participantId, sessionLabel: responsibility })
    host.ctx.on('llm/stream', async function* (options, next) {
      const messages = structuredClone(options.messages)
      const events = structuredClone(agent.session.snapshotEvents())
      expect(Session.create(agent.id, events, agent.session.header).deriveMessages()).toEqual(messages)
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const reader = await host.ctx.sessionPersistence.open(agent.id, 'read')
      let disk: readonly SessionEvent[]
      let diskHeader: unknown
      try {
        disk = (await reader.read()).events
        diskHeader = reader.header
        expect(disk).toEqual(events)
        expect(reader.header).toEqual({ ...agent.session.header, delegationDepth: 0 })
        expect(Session.create(reader.id, structuredClone([...disk]), reader.header).deriveMessages()).toEqual(messages)
      } finally { await reader.close() }
      const managed = messages.filter(message => message.source.kind === 'scope-agent-context'
        || message.source.kind === 'development-task-context')
      const shared = managed.filter(message => message.source.kind === 'scope-agent-context')
      const localMessages = managed.filter(message => message.source.kind === 'development-task-context')
      const projection = shared.flatMap(message => message.source.kind === 'scope-agent-context' && message.source.form === 'snapshot'
        ? [message.source.projection] : [])
      expect(bytes(managed)).toBeLessThanOrEqual(8000)
      expect(JSON.stringify(messages)).not.toContain(privateMarker)
      if (phase === 'mixed' && condition !== 'N') {
        expect(projection).toHaveLength(1)
        const current = projection[0]
        if (current === undefined) throw new Error('Mixed request has no admitted projection')
        expect(current.backend).toEqual(owner.ctx.developmentTaskContextBackend.identity)
        const framingBytes = bytes(shared) - Buffer.byteLength(current.text, 'utf8')
        expect(current.maxContextBytes).toBe(8000 - bytes(localMessages) - framingBytes)
        const view = await owner.ctx.developmentTasks.currentContextView(task.id)
        expect(current.taskRevision).toBe(view.task.revision)
        const covered = [...current.selectedSources, ...current.omittedSources.map(value => value.source)]
          .flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
        expect(covered.toSorted()).toEqual(view.task.context.map(value => value.id).toSorted())
        expect(current.text).not.toContain('CHECK_INITIAL_OK')
      } else expect(projection).toEqual([])
      for (const current of projection) {
        expect(shared.flatMap(value => value.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
          .toContain(current.text)
      }
      const visible = mixedVisibleEvidence(messages)
      requests.push({ role, phase, messages, events, disk, diskHeader, managedBytes: bytes(managed),
        localBytes: bytes(localMessages), sharedBytes: bytes(shared), framingBytes: bytes(shared)
          - projection.reduce((sum, value) => sum + Buffer.byteLength(value.text, 'utf8'), 0), visibleExitCode: visible.exitCode,
        visiblePolicyCorrection: visible.policy.some(value => value.includes(runtime.source.correction.newString)) })
      yield* next()
    })
    await run(host, agent, [toolCallResponse('read-public-baseline', 'read', { file_path: 'public/payment-policy.json' }),
      toolCallResponse('read-owned-artifact', 'read', { file_path: project.artifactPath }),
      toolCallResponse('read-owned-verification', 'read', { file_path: runtime.verificationPath })])
    const assignment = (await host.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (assignment === null) throw new Error('Original recipient Task missing')
    const original = { assignment, events: structuredClone(agent.session.snapshotEvents()),
      tools: structuredClone(host.adapter.requests[0]?.tools), agent, taskId: ownTask.id }
    expect(requests.filter(value => value.role === role)).toHaveLength(4)
    receivers.push({ host, agent, role, responsibility, project, original })
  }

  const commandOutcomes: unknown[] = []
  owner.ctx.on('tool-bash/foreground-completed', ({ operation, result }) => {
    commandOutcomes.push({ command: operation.command, workdir: operation.workdir, result: structuredClone(result) })
  })
  const context = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
  const receipts = async (source: 'local' | 'peer', count: number) => {
    await expect.poll(() => context().filter(value => source === 'local'
      ? value.localToolObservation !== undefined : value.peerToolObservation !== undefined).length, polling).toBe(count)
    await expect.poll(async () => source === 'local'
      ? (await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })).capture?.pendingSamples
      : (await peer.ctx.scopeAgentContributions.status({ agentId: documentAuthor.id })).capture?.pendingSamples, polling).toBe(0)
  }
  await writeFile(join(owner.workspace, 'verify.cjs'), checkSource, { flag: 'wx' })
  await writeFile(join(owner.workspace, 'check-state.json'), JSON.stringify({ code: 0, output: 'CHECK_INITIAL_OK\n' }), { flag: 'wx' })
  await run(owner, author, [toolCallResponse('policy-initial', 'write',
    { file_path: runtime.source.path, content: runtime.source.initialContent }),
  toolCallResponse('check-initial', 'bash', { command: runtime.source.command, description: 'Run the authorized verification command.' })])
  await receipts('local', 2)
  await writeFile(join(owner.workspace, 'check-state.json'), JSON.stringify({ code: 7, output: 'CHECK_CURRENT_FAILED\n' }))
  await run(owner, author, [toolCallResponse('policy-corrected', 'edit', { file_path: runtime.source.path,
    old_string: runtime.source.correction.oldString, new_string: runtime.source.correction.newString }),
  toolCallResponse('check-corrected', 'bash',
    { command: runtime.source.command, description: 'Run the authorized verification command.' })])
  await receipts('local', 4)
  for (const [index, document] of runtime.source.documents.entries()) {
    await run(peer, documentAuthor, [toolCallResponse(`documentation-${index}`, 'write',
      { file_path: document.path, content: document.content })])
    await receipts('peer', index + 1)
  }
  const overwrite = runtime.source.documentOverwrite
  const originalDocument = runtime.source.documents.find(value => value.path === overwrite.path)
  if (originalDocument === undefined) throw new Error('Original documentation source missing')
  const replaced = originalDocument.content.replace(overwrite.oldString, overwrite.newString)
  await run(peer, documentAuthor, [toolCallResponse('documentation-replaced', 'write', { file_path: overwrite.path, content: replaced })])
  await receipts('peer', 4)
  expect(await readFile(join(owner.workspace, runtime.source.path), 'utf8')).toBe(runtime.source.expectedContent)
  for (const document of runtime.source.documents) {
    expect(await readFile(join(peer.workspace, document.path), 'utf8')).toBe(document.path === overwrite.path ? replaced : document.content)
  }
  const sourceWorkspace = await realpath(owner.workspace)
  expect(commandOutcomes).toMatchObject([0, 7].map(exitCode => ({ command: runtime.source.command,
    workdir: sourceWorkspace, result: { exitCode } })))

  // The correction and command failure first become available at this one neutral continuation, never in an intermediate turn.
  for (const receiver of receivers) {
    expect(receiver.agent.session.snapshotEvents()).toEqual(receiver.original.events)
    if (condition === 'N') continue
    const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiver.host.peerId,
      ownerAddress, expiresAt: limits.expiresAt, responsibility: receiver.responsibility })
    const assignment = receiver.original.assignment
    await receiver.host.ctx.scopeAgentContext.bind({ agentId: receiver.agent.id, expectedBindingId: null, invitation, automatic: null,
      localTask: { taskId: assignment.taskId, taskBindingId: assignment.bindingId,
        expectedBindingEpoch: assignment.expectedBindingEpoch } })
    expect(receiver.host.adapter.requests).toHaveLength(4)
  }
  phase = 'mixed'
  for (const receiver of receivers) {
    await run(receiver.host, receiver.agent, mixedArtifactReplies(receiver.role, receiver.host.workspace,
      receiver.project.artifactPath, runtime.verificationPath))
    expect(receiver.host.adapter.requests).toHaveLength(7)
    for (const request of receiver.host.adapter.requests) expect(request.tools).toEqual(receiver.original.tools)
    for (const event of receiver.agent.session.snapshotEvents()) {
      if (event.type !== 'tool/result') continue
      expect(event.data.error).toBeUndefined()
      for (const block of event.data.message.content) if (block.type === 'tool-result') expect(block.isError).not.toBe(true)
    }
  }
  if (condition === 'semantic') for (const receiver of receivers) {
    const actual = receiver.host.adapter.requests[4]
    if (actual === undefined) throw new Error('Actual artifact request missing')
    const masked = { ...actual, messages: actual.messages.map(message => ({ ...message,
      content: [{ type: 'text' as const, text: 'No shared facts were delivered in this message.' }] })) }
    // Keep the complete source metadata while removing model-visible evidence; metadata must not supply an answer.
    expect(JSON.stringify(masked.messages.map(message => message.source))).toContain(runtime.source.correction.newString)
    expect(mixedVisibleEvidence(masked.messages)).toEqual({ policy: [], exitCode: null })
    const replies = mixedArtifactReplies(receiver.role, receiver.host.workspace, receiver.project.artifactPath, runtime.verificationPath)
    const written = replies.map((reply) => {
      const block = reply(masked).find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      if (block?.type !== 'block-end' || block.block.type !== 'tool-call') throw new Error('Expected real Write reply')
      return JSON.parse(block.block.arguments) as { file_path: string; content: string }
    })
    const verification = written.find(value => value.file_path === runtime.verificationPath)
    if (verification === undefined) throw new Error('Expected verification Write')
    expect(parseMixedVerification(sealDataArtifact(verification.content))).toEqual({ version: 1, status: 'unavailable', exitCode: null })
    if (receiver.role === 'B') {
      const policy = written.find(value => value.file_path === receiver.project.artifactPath)
      if (policy === undefined) throw new Error('Expected policy Write')
      expect(parsePolicy(sealDataArtifact(policy.content)).maxRetries).toBe(3)
    }
  }
  const artifacts = []
  for (const receiver of receivers) artifacts.push({ role: receiver.role,
    main: sealDataArtifact(await readFile(join(receiver.host.workspace, receiver.project.artifactPath), 'utf8')),
    verification: sealDataArtifact(await readFile(join(receiver.host.workspace, runtime.verificationPath), 'utf8')) })
  const b = artifacts.find(value => value.role === 'B')
  const c = artifacts.find(value => value.role === 'C')
  if (b === undefined || c === undefined) throw new Error('Both independent artifacts are required')
  const visibleVerification = Object.fromEntries((['B', 'C'] as const).map(role => [role,
    requests.findLast(value => value.role === role && value.phase === 'mixed')?.visibleExitCode ?? null])) as Record<Role, number | null>
  const grades = gradeMixedArtifacts({ condition, policy: b.main, cases: c.main,
    verification: { B: b.verification, C: c.verification }, visibleVerification, oracle })
  expect(grades.verification.B.status).toBe('passed')
  expect(grades.verification.C.status).toBe('passed')
  if (condition === 'semantic') expect(grades.pairStatus).toBe('passed')
  if (condition === 'N') {
    expect(visibleVerification).toEqual({ B: null, C: null })
    expect(grades.currentEvidenceAvailable).toEqual({ B: false, C: false })
    expect(grades.pairStatus).toBe('failed')
  }

  const preserved = []
  phase = 'left'
  for (const receiver of receivers) {
    if (condition !== 'N') {
      const status = await receiver.host.ctx.scopeAgentContext.status({ agentId: receiver.agent.id })
      if (status.eligibility !== 'eligible' || status.state.binding?.kind !== 'local-task-scope') {
        throw new Error('Original composite binding missing')
      }
      expect(status.state.automatic).toBeNull()
      await receiver.host.ctx.scopeAgentContext.leave({ agentId: receiver.agent.id, expectedBindingId: status.state.binding.id })
    }
    await run(receiver.host, receiver.agent)
    const local = await receiver.host.ctx.scopeAgentContributions.localStatus({ agentId: receiver.agent.id })
    expect(local.assignment).toEqual(receiver.original.assignment)
    expect(local.capture).toBeNull()
    expect(receiver.agent).toBe(receiver.original.agent)
    expect(receiver.agent.session.snapshotEvents().slice(0, receiver.original.events.length)).toEqual(receiver.original.events)
    expect(receiver.host.adapter.requests).toHaveLength(8)
    expect(receiver.host.adapter.requests.length).toBeLessThanOrEqual(runtime.ordinary.maxCalls)
    preserved.push({ role: receiver.role, agentId: receiver.agent.id, originalAssignment: receiver.original.assignment,
      finalAssignment: local.assignment, originalEvents: receiver.original.events, originalTools: receiver.original.tools,
      finalLocalCapture: local.capture })
    expect(receiver.agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['read', 'read', 'read', 'write', 'write'])
  }
  let semanticAudit: readonly SessionEvent[] = []
  if (condition === 'semantic') {
    if (owner.semanticAuditPersistence === undefined) throw new Error('Summary audit not isolated')
    expect(await owner.ctx.sessionPersistence.stat(SessionId(summaryConfig.auditSessionId))).toBeUndefined()
    const audit = await owner.semanticAuditPersistence.open(SessionId(summaryConfig.auditSessionId), 'read')
    try { semanticAudit = (await audit.read()).events } finally { await audit.close() }
    expect(summaryAdapter.calls).toHaveLength(2)
    expect(semanticAudit.filter(value => value.type === 'context/semantic-result')).toHaveLength(2)
  } else expect(summaryAdapter.calls).toEqual([])
  const sourceEvents = { owner: await owner.readEvents(author), peer: await peer.readEvents(documentAuthor) }
  const hostIdentities = hosts.map(host => ({ peerId: host.peerId, root: host.root, workspace: host.workspace }))
  expect(new Set(hostIdentities.map(value => value.peerId)).size).toBe(4)
  expect(requests).toHaveLength(16)
  const finalView = await owner.ctx.developmentTasks.currentContextView(task.id)
  await close()
  expect(closed).toHaveLength(4)
  const requestedOutput = process.env.DSH_MIXED_ARTIFACTS
  if (requestedOutput === undefined) temporaryOutput = await mkdtemp(join(tmpdir(), 'dsh-mixed-artifacts-'))
  const directory = requestedOutput ?? temporaryOutput
  if (directory === undefined) throw new Error('Artifact directory missing')
  const path = join(directory, `${condition}.json`)
  await writeFile(path, JSON.stringify({ protocol: runtime.id, condition, kind: 'controlled-artifact-calibration',
    externalModelCalls: 0, modelQualityMeasured: false, transport: 'in-process', contextBudgetBytes: 8000,
    runtime, sourceEvents, commandOutcomes, finalView, hosts: hostIdentities, requests, artifacts, visibleVerification, preserved,
    grades, semanticAudit, summaryCalls: summaryAdapter.calls, resources: closed,
    summary: { recipientRequests: requests.length, summaryRequests: summaryAdapter.calls.length,
      maxManagedBytes: Math.max(...requests.map(value => value.managedBytes)), pairStatus: grades.pairStatus } }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 })
  console.info('mixed artifact calibration', JSON.stringify({ path, condition, pairStatus: grades.pairStatus,
    currentEvidenceAvailable: grades.currentEvidenceAvailable, recipientRequests: requests.length,
    maxManagedBytes: Math.max(...requests.map(value => value.managedBytes)), modelQualityMeasured: false }))
}

// LocalBashExecutor is the production POSIX provider; Windows uses a different shell provider.
for (const condition of mixedStudyConditions) it.skipIf(process.platform === 'win32')(
  `calibrates ${condition} mixed artifacts from the original Sessions within 8000 bytes`,
  async (test) => { await calibrate(condition, test) })
