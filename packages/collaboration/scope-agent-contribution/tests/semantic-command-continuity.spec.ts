/** Real command history crosses a fixed summary-wire ceiling without replacing the receiving Session or its local Task. */
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { DEVELOPMENT_TASK_DOMAIN_NAME } from '@deepseek-ai/dsh-development-task-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { semanticCapturedInputSchema, semanticSummaryInputSchema } from '@deepseek-ai/dsh-development-task-context/src/semantic-schema.ts'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { expandSemanticText } from '../../development-task-context/tests/fixtures/semantic-display.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { nativeContributionDomain } from '../src/state.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const command = 'node verify.cjs'
const commandCount = 48
const policy = 'Retry transient network failures at most once. Never retry validation failures.\n'
const config = { auditSessionId: 'continuous-command-summary', provider: 'continuous-summary', model: 'controlled-summary',
  maxInputBytes: 8192, maxCapturedInputBytes: 1048576, maxOutputTokens: 1024, maxOutputBytes: 8192,
  timeoutMs: 10000, maxConcurrentCalls: 1, maxCalls: 8 }
const checkSource = 'const fs=require("node:fs");const path="verification-count.txt";'
  + 'const n=Number(fs.readFileSync(path,"utf8"))+1;fs.writeFileSync(path,String(n));'
  + 'const code=n%2===0?7:0;process.stdout.write(`VERIFY_SAMPLE_${n}_${code===0?"OK":"FAILED"}\\n`);process.exit(code);\n'

class SummaryAdapter extends LlmAdapter {
  readonly calls: { system: GenerateOptions['system']; messages: GenerateOptions['messages']; bytes: number }[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    expect(options.purpose).toBe('context-summary')
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Summary actual input is absent')
    const input = semanticSummaryInputSchema.parse(JSON.parse(block.text) as unknown)
    expect(input.sources).toHaveLength(1)
    const source = input.sources[0]
    if (source === undefined) throw new Error('Policy source is absent')
    expect(source.body).toContain(policy.trim())
    const bytes = Buffer.byteLength((options.system ?? '') + block.text)
    expect(bytes).toBeLessThanOrEqual(config.maxInputBytes)
    this.calls.push({ system: options.system, messages: structuredClone(options.messages), bytes })
    const text = JSON.stringify({ version: 1, decisions: [{ sourceId: source.sourceId, relevant: true }],
      updates: [{ text: 'Keep the authorized retry policy.', sources: [{ sourceId: source.sourceId, quote: policy.trim() }] }] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 80 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function assign(host: TestHost, agent: Agent) {
  const task = await rootTask(host)
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => host.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId,
    sessionLabel: 'Maintain the independently owned payment implementation and verification.' })
  const assignment = (await host.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
  if (assignment === null) throw new Error('Original local Task is absent')
  return assignment
}

async function retained(host: TestHost, agent: Agent) {
  const raw: unknown = JSON.parse(await readFile(join(host.root, 'domains', `${nativeContributionDomain.name}.json`), 'utf8'))
  const domain = z.object({ tables: z.object({ sessions: z.record(z.string(), z.unknown()) }) }).parse(raw)
  return nativeContributionDomain.tables.sessions.valueSchema.parse(domain.tables.sessions[agent.id])
}

async function audit(host: TestHost): Promise<readonly SessionEvent[]> {
  if (host.semanticAuditPersistence === undefined) throw new Error('Isolated summary persistence is absent')
  const handle = await host.semanticAuditPersistence.open(SessionId(config.auditSessionId), 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}

// Actual LocalBashExecutor and foreground process outcomes require a POSIX shell.
it.skipIf(process.platform === 'win32')('keeps 48 real commands current when full history exceeds the model limit',
  async (test) => {
    const network = new TestNetwork()
    const hosts: TestHost[] = []
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const closed: { peerId: string; exitCodes: readonly number[] }[] = []
    const measurements: unknown[] = []
    const evidence: Record<string, unknown> = { kind: 'real-command-summary-wire-continuity', physicalDevices: 1,
      topology: 'Three in-process Loader Hosts; authenticated private TestNetwork; real Bash subprocesses.',
      externalModelCalls: 0, commandCount, modelInputBytes: config.maxInputBytes,
      capturedInputBytes: config.maxCapturedInputBytes, managedContextBytes: 8000, measurements, closed }
    onTestFinished(async () => {
      release.resolve(undefined)
      const errors: unknown[] = []
      for (const host of hosts.splice(0).reverse()) {
        try { await host.close(); closed.push({ peerId: host.peerId, exitCodes: [...host.exitCodes] }) }
        catch (error) { errors.push(error) }
      }
      const artifact = process.env.DSH_SEMANTIC_COMMAND_ARTIFACTS
      if (artifact !== undefined) await writeFile(artifact, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      if (errors.length > 0) throw new AggregateError(errors, 'Continuous command Hosts did not settle')
      expect(network.peers.size).toBe(0)
      expect(closed).toHaveLength(3)
      expect(closed.every(item => item.exitCodes.length === 0)).toBe(true)
    })
    const polling = { timeout: test.task.timeout }
    const invitationLifetimeMs = test.task.timeout ?? 120000
    const summary = new SummaryAdapter()
    const owner = await createHost(network, 'owner', 'native', { ownerLocal: true, contextBackend: 'semantic',
      semantic: { config, adapter: summary }, maxContextBytes: 8000, invitationLifetimeMs })
    hosts.push(owner)
    const source = await createHost(network, 'source', 'native', { ownerLocal: true, invitationLifetimeMs })
    hosts.push(source)
    const receiver = await createHost(network, 'receiver', 'native', { ownerLocal: true,
      contextBackend: 'reported', maxContextBytes: 8000, invitationLifetimeMs })
    hosts.push(receiver)
    const task = await rootTask(owner)
    const author = await source.createAgent('continuous-verification-author')
    const recipient = await receiver.createAgent('continuous-payment-maintainer')
    const sourceAssignment = await assign(source, author)
    const localAssignment = await assign(receiver, recipient)
    await writeFile(join(source.workspace, 'verify.cjs'), checkSource, { flag: 'wx' })
    await writeFile(join(source.workspace, 'verification-count.txt'), '0', { flag: 'wx' })
    await writeFile(join(receiver.workspace, 'local-work.txt'), 'Original local responsibility remains active.\n', { flag: 'wx' })
    const outcomes: unknown[] = []
    source.ctx.on('tool-bash/foreground-completed', ({ operation, result }) => {
      outcomes.push({ command: operation.command, workdir: operation.workdir, result: structuredClone(result) })
    })
    const requests: GenerateOptions[] = []
    const preservedRequests: unknown[] = []
    evidence.recipientRequests = preservedRequests
    evidence.summaryCalls = summary.calls
    receiver.ctx.on('llm/stream', async function* (options, next) {
      const messages = structuredClone(options.messages)
      const events = structuredClone(recipient.session.snapshotEvents())
      expect(await receiver.ctx.sessions.flush(recipient.session)).toBe(true)
      const disk = await receiver.readEvents(recipient)
      expect(disk).toEqual(events)
      expect(Session.create(recipient.id, structuredClone([...disk]), recipient.session.header).deriveMessages()).toEqual(messages)
      const managed = messages.filter(item => item.source.kind === 'scope-agent-context' || item.source.kind === 'development-task-context')
      const bytes = managed.flatMap(item => item.content).reduce((sum, block) => sum
        + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0)
      expect(bytes).toBeLessThanOrEqual(8000)
      const local = await receiver.ctx.scopeAgentContributions.localStatus({ agentId: recipient.id })
      expect(local.assignment).toEqual(localAssignment)
      expect(local.capture).toBeNull()
      requests.push(options)
      preservedRequests.push({ messages, events, disk, managedBytes: bytes, assignment: local.assignment })
      if (requests.length === 2) {
        entered.resolve(undefined)
        await release.promise
      }
      yield* next()
    })
    await run(receiver, recipient)
    const originalEvents = structuredClone(recipient.session.snapshotEvents())
    const originalTools = structuredClone(requests[0]?.tools)
    const limits = { expiresAt: Date.now() + invitationLifetimeMs, maxSamples: commandCount + 1, maxSampleBytes: 8192 }
    const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner route is absent')
    const entry = (await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress, expiresAt: limits.expiresAt })).entry
    const requested = await source.ctx.scopeAgentContributions.request({ agentId: author.id, expectedCapture: null, entry,
      roots: [source.workspace], tools: ['write'], commands: [{ command, rootIndex: 0 }], limits })
    if (requested.capture === null) throw new Error('Source permission is absent')
    const selection = requested.capture.selection
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id }))
      .entries.find(item => item.entry.entryId === entry.entryId)?.result.status, polling).toBe('pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress })
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: author.id })).capture?.collecting,
      polling).toBe(true)
    const publications = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined)
    const receipts = async (count: number) => {
      await expect.poll(() => publications().length, polling).toBe(count)
      await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: author.id })).capture?.pendingSamples,
        polling).toBe(0)
    }
    const bashReply = (n: number) => toolCallResponse(`verification-${n}`, 'bash', { command,
      description: 'Run the authorized payment verification command.' })
    await run(source, author, [toolCallResponse('shared-policy', 'write', { file_path: 'policy.md', content: policy }), bashReply(1)])
    await receipts(2)
    const initialPublication = publications()[1]
    expect(initialPublication?.peerToolObservation).toMatchObject({ kind: 'command-observation', exitCode: 0,
      stdout: { state: 'included', text: 'VERIFY_SAMPLE_1_OK\n' } })
    receiver.script.push(toolCallResponse('continue-original-local-work', 'read', { file_path: 'local-work.txt' }),
      textResponse('Updated verification considered within my original responsibility.'))
    const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiver.peerId,
      ownerAddress, expiresAt: limits.expiresAt,
      responsibility: 'Maintain the independently owned payment implementation and verification.' })
    const bound = await receiver.ctx.scopeAgentContext.bind({ agentId: recipient.id, expectedBindingId: null, invitation,
      localTask: { taskId: localAssignment.taskId, taskBindingId: localAssignment.bindingId,
        expectedBindingEpoch: localAssignment.expectedBindingEpoch },
      automatic: { goal: 'Keep my existing payment work aligned with the latest authorized verification result.',
        activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 } })
    if (bound.binding === null) throw new Error('Composite automatic binding is absent')
    await expect.poll(async () => {
      const status = await receiver.ctx.scopeAgentContext.status({ agentId: recipient.id })
      if (status.eligibility === 'eligible' && status.state.pauseReason === 'failed') return 'failed'
      return requests.length === 2 ? 'entered' : 'waiting'
    }, polling).not.toBe('waiting')
    expect(requests).toHaveLength(2)
    await entered.promise
    expect(summary.calls).toHaveLength(1)
    await run(source, author, Array.from({ length: commandCount - 1 }, (_, index) => bashReply(index + 2)))
    await receipts(commandCount + 1)
    expect(await readFile(join(source.workspace, 'verification-count.txt'), 'utf8')).toBe(String(commandCount))
    expect(await readFile(join(source.workspace, 'policy.md'), 'utf8')).toBe(policy)
    const actualPublications = structuredClone(publications())
    const latest = actualPublications.at(-1)
    expect(latest?.peerToolObservation).toMatchObject({ kind: 'command-observation', exitCode: 7,
      sequence: commandCount + 1, fields: { command, rootIndex: 0 }, stdout: { state: 'included', text: 'VERIFY_SAMPLE_48_FAILED\n' } })
    const row = await retained(source, author)
    expect(row.samples).toHaveLength(commandCount + 1)
    const sourceEvents = await source.readEvents(author)
    const ownerTaskFile: unknown = JSON.parse(await readFile(join(owner.root, 'domains', `${DEVELOPMENT_TASK_DOMAIN_NAME}.json`), 'utf8'))
    const ownerTaskDomain = z.object({ tables: z.object({ events: z.record(z.string(), z.unknown()) }) }).parse(ownerTaskFile)
    evidence.ownerTaskDomain = ownerTaskFile
    for (const [index, sample] of row.samples.entries()) {
      expect(sourceEvents.find(item => item.seq === sample.callSeq)?.type).toBe('tool/call')
      expect(sourceEvents.find(item => item.seq === sample.resultSeq)?.type).toBe('tool/result')
      const receipt = sample.receipt
      const grant = row.capture?.invitation?.grant
      if (receipt === undefined || grant === undefined) throw new Error('Owner admission receipt is absent')
      expect(receipt).toMatchObject({ taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
        grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration,
        sourceId: sample.sample.sourceId, sequence: sample.sample.sequence, publicationId: actualPublications[index]?.id })
      const admitted = owner.ctx.developmentTasks.log().find(item => item.nodeId === receipt.event.nodeId && item.seq === receipt.event.seq)
      expect(admitted).toMatchObject({ taskId: task.id, revision: receipt.revision,
        change: { kind: 'context-published', publication: actualPublications[index] } })
      expect(ownerTaskDomain.tables.events[`${receipt.event.nodeId}:${receipt.event.seq}`]).toEqual(admitted)
    }
    expect(sourceEvents.filter(item => item.type === 'tool/call').map(item => item.data.name))
      .toEqual(['write', ...Array.from({ length: commandCount }, () => 'bash')])
    const canonicalWorkspace = await realpath(source.workspace)
    expect(outcomes).toHaveLength(commandCount)
    for (const [index, outcome] of outcomes.entries()) expect(outcome).toMatchObject({ command, workdir: canonicalWorkspace,
      result: { exitCode: (index + 1) % 2 === 0 ? 7 : 0, aborted: false, timedOut: false } })
    evidence.source = { limits, selection, publications: actualPublications, samples: row.samples, sourceEvents, outcomes }
    release.resolve(undefined)
    await expect.poll(() => recipient.session.snapshotEvents().filter(item => item.type === 'turn/end').length, polling).toBe(2)
    await recipient.whenIdle()
    expect(requests).toHaveLength(3)
    expect(summary.calls).toHaveLength(2)
    const shared = requests.slice(1).map((options) => {
      const messages = options.messages.filter(item => item.source.kind === 'scope-agent-context' && item.source.form === 'snapshot')
      expect(messages).toHaveLength(1)
      const sourceValue = messages[0]?.source
      if (sourceValue?.kind !== 'scope-agent-context' || sourceValue.form !== 'snapshot') throw new Error('Shared request is absent')
      return sourceValue.projection
    })
    for (const [index, projection] of shared.entries()) {
      if (projection === undefined) throw new Error('Shared projection is absent')
      const expanded = z.object({ mandatory: z.array(z.object({ kind: z.string(), publication: z.unknown() }).loose()) })
        .parse(expandSemanticText(projection.text))
      expect(expanded.mandatory).toHaveLength(1)
      expect(expanded.mandatory[0]?.publication).toEqual(index === 0 ? initialPublication : latest)
    }
    expect(shared[1]?.text).not.toContain('VERIFY_SAMPLE_1_OK')
    expect(shared[1]?.text).toContain('VERIFY_SAMPLE_48_FAILED')
    expect(shared[1]?.omittedSources.filter(item => item.reason === 'superseded')).toHaveLength(commandCount - 1)
    const events = await audit(owner)
    const reservations = events.filter(item => item.type === 'context/semantic-request')
    expect(reservations).toHaveLength(2)
    const results = events.filter(item => item.type === 'context/semantic-result')
    expect(results).toHaveLength(2)
    for (const [index, result] of results.entries()) {
      expect(result.data).toMatchObject({ version: 7, status: 'completed', requestSeq: reservations[index]?.seq,
        key: reservations[index]?.data.key, projection: { text: shared[index]?.text } })
    }
    for (const [index, reservation] of reservations.entries()) {
      const request = reservation.data
      if (request.version !== 2) throw new Error('Current writer must retain separate version-two capture')
      expect(request.messages).toEqual(summary.calls[index]?.messages)
      expect(request.system).toBe(summary.calls[index]?.system)
      const captured = semanticCapturedInputSchema.parse(JSON.parse(request.capturedInput) as unknown)
      const fullBytes = Buffer.byteLength(request.system + request.capturedInput)
      const wire = semanticSummaryInputSchema.parse(JSON.parse(request.messages[0]?.content[0]?.text ?? 'null') as unknown)
      expect(Buffer.byteLength(request.capturedInput)).toBeLessThanOrEqual(config.maxCapturedInputBytes)
      expect(captured.coverage.omittedSources).toHaveLength(index === 0 ? 0 : commandCount - 1)
      expect(wire.coverage.omittedSources).toEqual([])
      expect(wire.mandatory).toEqual(captured.mandatory)
      expect(wire.sources).toEqual(captured.sources)
      if (index === 0) expect(fullBytes).toBeLessThanOrEqual(config.maxInputBytes)
      else {
        expect(fullBytes).toBeGreaterThan(config.maxInputBytes)
        expect(wire.coverage.supersededSources).toEqual([{ source: { kind: 'task', taskId: task.id,
          revision: captured.task.revision }, count: commandCount - 1 }])
        expect(captured.coverage.omittedSources.map(item => item.source.kind === 'publication' ? item.source.publicationId : null))
          .toEqual(actualPublications.slice(1, -1).map(item => item.id))
      }
      measurements.push({ ordinal: request.ordinal, fullBytes, wireBytes: summary.calls[index]?.bytes,
        fullOmitted: captured.coverage.omittedSources.length, wireHistory: wire.coverage.supersededSources })
    }
    evidence.summaryAuditBeforeWithdrawal = events
    evidence.summaryCalls = summary.calls
    receiver.script.push(textResponse('Withdrawn verification is no longer current evidence.'))
    await source.ctx.scopeAgentContributions.stop({ agentId: author.id, expectedCapture: selection })
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: author.id })).capture, polling).toBeNull()
    await expect.poll(async () => {
      const status = await receiver.ctx.scopeAgentContext.status({ agentId: recipient.id })
      return recipient.session.snapshotEvents().filter(item => item.type === 'turn/end').length === 3
        || (status.eligibility === 'eligible' && status.state.pauseReason === 'failed')
    }, polling).toBe(true)
    evidence.withdrawalStatus = await receiver.ctx.scopeAgentContext.status({ agentId: recipient.id })
    evidence.withdrawnOwnerView = await owner.ctx.developmentTasks.currentContextView(task.id)
    evidence.withdrawalEvents = structuredClone(recipient.session.snapshotEvents())
    expect(recipient.session.snapshotEvents().filter(item => item.type === 'turn/end')).toHaveLength(3)
    await recipient.whenIdle()
    expect(requests).toHaveLength(4)
    expect(summary.calls).toHaveLength(2)
    const lastText = requests.at(-1)?.messages.flatMap(item => item.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(lastText).not.toContain('VERIFY_SAMPLE_')
    expect(lastText).not.toContain(policy.trim())
    expect((await retained(source, author)).samples).toEqual([])
    const finalView = await owner.ctx.developmentTasks.currentContextView(task.id)
    const terminalPublications = finalView.task.context.filter(item => item.peerContribution?.ended === 'left')
    expect(terminalPublications).toHaveLength(1)
    const terminal = terminalPublications[0]
    if (terminal === undefined) throw new Error('Complete terminal publication is absent')
    const finalSnapshots = requests.at(-1)?.messages.filter(item => item.source.kind === 'scope-agent-context'
      && item.source.form === 'snapshot') ?? []
    expect(finalSnapshots).toHaveLength(1)
    const finalSnapshot = finalSnapshots[0]
    if (finalSnapshot?.source.kind !== 'scope-agent-context' || finalSnapshot.source.form !== 'snapshot') {
      throw new Error('Actual final shared message is absent')
    }
    expect(finalSnapshot.content).toHaveLength(1)
    const actualBlock = finalSnapshot.content[0]
    if (actualBlock?.type !== 'text') throw new Error('Actual final shared text is absent')
    const finalProjection = finalSnapshot.source.projection
    const taskSource = { kind: 'task', taskId: task.id, revision: finalView.task.revision }
    const terminalSource = { ...taskSource, kind: 'publication', publicationId: terminal.id }
    expect(finalProjection.selectedSources).toEqual([taskSource, terminalSource])
    expect(finalProjection.omittedSources).toEqual(actualPublications.map(publication => ({
      source: { ...taskSource, kind: 'publication', publicationId: publication.id }, reason: 'withdrawn',
    })))
    const expanded = expandSemanticText(actualBlock.text)
    expect(expanded).toEqual(expandSemanticText(finalProjection.text))
    expect(expanded).toMatchObject({ mandatory: [{ kind: 'withdrawal', basis: 'current-task-as-reported',
      source: terminalSource, publication: terminal }], updates: [], coverage: {
      selectedSources: finalProjection.selectedSources, omittedSources: [], supersededSources: [],
      withdrawnSources: [{ source: taskSource, count: commandCount + 1 }],
    } })
    for (const publication of actualPublications) expect(actualBlock.text).not.toContain(publication.id)
    evidence.withdrawalProjection = { actualText: actualBlock.text, expanded, projection: finalProjection }
    const local = await receiver.ctx.scopeAgentContributions.localStatus({ agentId: recipient.id })
    expect(local.assignment).toEqual(localAssignment)
    expect(local.capture).toBeNull()
    expect((await source.ctx.scopeAgentContributions.localStatus({ agentId: author.id })).assignment).toEqual(sourceAssignment)
    expect(receiver.ctx.agents.get(recipient.id)).toBe(recipient)
    expect(recipient.session.snapshotEvents().slice(0, originalEvents.length)).toEqual(originalEvents)
    for (const request of requests) expect(request.tools).toEqual(originalTools)
    const finalEvents = recipient.session.snapshotEvents()
    expect(finalEvents.filter(item => item.type === 'user/message' && item.data.source.kind === 'user')).toHaveLength(1)
    expect(finalEvents.filter(item => item.type === 'user/message' && item.data.source.kind === 'scope-agent-pulse')).toHaveLength(2)
    expect(finalEvents.filter(item => item.type === 'scope-agent-context/request')).toHaveLength(3)
    expect(finalEvents.filter(item => item.type === 'turn/end').every(item => item.data.reason.kind === 'completed')).toBe(true)
    evidence.recipient = { requests: preservedRequests, originalEvents, originalTools, localAssignment,
      finalStatus: await receiver.ctx.scopeAgentContext.status({ agentId: recipient.id }), finalView }
    evidence.summaryAudit = await audit(owner)
    expect(evidence.summaryAudit).toEqual(events)
    evidence.calls = { sourceControlled: source.adapter.requests.length, recipientControlled: requests.length,
      summaryControlled: summary.calls.length, external: 0 }
    evidence.completed = true
  })
