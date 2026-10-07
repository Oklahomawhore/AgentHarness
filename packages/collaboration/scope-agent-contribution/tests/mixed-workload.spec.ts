/** Bounded mixed-work measurement through actual capture, independent receivers, and exact durable request replay. */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const temporaryArtifacts: string[] = []
afterEach(async () => {
  const failures: unknown[] = []
  // Recipients and the contributing peer retire while the original owner can still acknowledge their cleanup.
  for (const host of hosts.splice(0).reverse()) {
    try { await host.close() } catch (error) { failures.push(error) }
  }
  for (const root of temporaryArtifacts.splice(0)) {
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length !== 0) throw new AggregateError(failures, 'Mixed-workload hosts did not settle')
})

type Phase = 'initial' | 'corrected' | 'mixed'
type Role = 'client' | 'qa'
const command = 'node verify.cjs'
const initialPolicy = '# Payment client policy\n\nRequired fields: orderId, accountId.\nmaxRetries: 3\n'
  + 'Retry only NETWORK_TIMEOUT. Never retry PAYMENT_DECLINED or unknown external errors. Preserve each complete request body.\n'
const correctedPolicy = initialPolicy.replace('maxRetries: 3', 'maxRetries: 1')
const checkSource = '// MIXED_PRIVATE_CHECK_IMPLEMENTATION\n'
  + 'const state=JSON.parse(require("node:fs").readFileSync("check-state.json","utf8"));\n'
  + 'process.stdout.write(state.output);process.exit(state.code);\n'
const documents = [
  [join('docs', 'assets.md'), '# Marketing asset maintenance\n\n', [
    'The illustration library uses a stable export name so the campaign editor can replace a drawing without changing page layout.',
    'Designers retain the editable original beside each exported image; the web build consumes only the reviewed export.',
    'Every illustration lists its author and usage permission in the asset index. Missing attribution blocks publication of that asset.',
    'A narrow-screen crop should retain the subject and remove decorative background elements before text is reduced.',
    'Screenshots used in launch material are reviewed for private account names and replaced with the public demonstration account.',
    'The weekly asset review checks transparent edges against both page themes and records the accepted export in the design changelog.',
    'Historical illustrations remain available to the campaign team but are not copied into the active distribution directory.',
    'New campaign variants should reuse the existing spacing and contrast checks before requesting a new page component.',
  ]],
  [join('docs', 'search.md'), '# Documentation search maintenance\n\n', [
    'Documentation titles should describe the user task and remain understandable when displayed without their surrounding navigation.',
    'The search index contains published guides and reference pages. Draft review notes stay outside the public search collection.',
    'Editors check that short labels remain distinct after translations are applied; identical headings make search results ambiguous.',
    'Each search example includes a common spelling and a domain-specific term so reviewers can compare the ranked result list.',
    'Broken documentation links are corrected in the owning page rather than hidden by the search result renderer.',
    'The release checklist includes one keyboard-only search journey and verifies that focus returns to the search field after closing.',
    'Search metrics are aggregated by page category and never include private query text from individual employees.',
    'The navigation owner records renamed pages before the next index build to preserve established public links.',
  ]],
  [join('docs', 'accessibility.md'), '# Documentation accessibility review\n\n', [
    'Each screenshot receives descriptive alternative text that explains the visible action instead of repeating the adjacent heading.',
    'Interactive examples must remain operable with a keyboard, with a visible focus indicator throughout the demonstrated sequence.',
    'Tables have descriptive column labels and preserve their reading order on narrow screens without hiding relevant cell contents.',
    'A warning uses plain text in addition to color so its meaning remains available in high contrast and monochrome displays.',
    'Video demonstrations include captions for spoken instructions and a nearby text description of actions shown without narration.',
    'Reviewers check navigation landmarks before publication and keep the page title unique within its documentation section.',
    'Small visual differences are reviewed at normal zoom before changing spacing that other documentation pages depend upon.',
    'A follow-up review records the tested screen size and browser so the publishing team can reproduce any remaining layout concern.',
  ]],
] as const

// This fixture executes the actual LocalBashExecutor; Windows uses a different shell provider.
it.skipIf(process.platform === 'win32')('measures two responsibilities after API correction, command failure, and newer peer documents', async (test) => {
  const polling = { timeout: test.task.timeout }
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: true, contextBackend: 'reported' })
  hosts.push(owner)
  const peer = await createHost(network, 'source')
  hosts.push(peer)
  const task = await rootTask(owner)
  const author = await owner.createAgent('mixed-api-author')
  const documentAuthor = await peer.createAgent('mixed-document-author')
  const participantId = developmentAgentParticipantId(author.id)
  await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(value => value.id === participantId), polling).toBe(true)
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId, sessionLabel: 'Maintain the payment API policy.' })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })
  if (local.assignment === null) throw new Error('Source local responsibility missing')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 24, maxSampleBytes: 8192 }
  const selected = await owner.ctx.scopeAgentContributions.requestLocal({ agentId: author.id, expectedCapture: null,
    ...local.assignment, roots: [owner.workspace], tools: ['write', 'edit'], commands: [{ command, rootIndex: 0 }], limits })
  if (selected.capture === null) throw new Error('Source command/file permission missing')
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address missing')
  const entry = (await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: limits.expiresAt })).entry
  const requested = await peer.ctx.scopeAgentContributions.request({ agentId: documentAuthor.id, expectedCapture: null, entry,
    roots: [peer.workspace], tools: ['write'], limits })
  if (requested.capture === null) throw new Error('Independent document permission missing')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id }))
    .entries.find(value => value.entry.entryId === entry.entryId)?.result.status, polling).toBe('pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
    expectedProposal: requested.capture.proposal, limits, ownerAddress })
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })).capture?.collecting,
    polling).toBe(true)
  await expect.poll(async () => (await peer.ctx.scopeAgentContributions.status({ agentId: documentAuthor.id })).capture?.collecting,
    polling).toBe(true)

  const started = performance.now()
  let phase: Phase = 'initial'
  let policySources: string[] = []
  let commandSource = ''
  const requests: unknown[] = []
  const timeline: unknown[] = []
  const commandOutcomes: { command: string; workdir: string; exitCode: number | null; result: unknown; elapsedMs: number }[] = []
  owner.ctx.on('tool-bash/foreground-completed', ({ operation, result }) => {
    commandOutcomes.push({ command: operation.command, workdir: operation.workdir, exitCode: result.exitCode,
      result: structuredClone(result), elapsedMs: performance.now() - started })
  })
  const summary: {
    role: Role
    phase: Phase
    managedBytes: number
    policyDelivered: boolean
    commandDelivered: boolean
    selected: number
    budgetOmissions: number
  }[] = []
  const receivers: {
    host: TestHost
    agent: Agent
    role: Role
    participantId: string
    sessionLabel: string
    backendParticipantId: string
  }[] = []
  for (const role of ['client', 'qa'] as const) {
    const host = await createHost(network, 'receiver', 'native', { ownerLocal: true, contextBackend: 'reported', maxContextBytes: 8000 })
    hosts.push(host)
    const agent = await host.createAgent(`mixed-${role}`)
    const personalTask = await rootTask(host)
    const participant = developmentAgentParticipantId(agent.id)
    const responsibility = role === 'client' ? 'Maintain the payment client policy and preserve complete request bodies.'
      : 'Maintain payment QA cases for retry boundaries, non-retry errors, and observed verification failures.'
    await expect.poll(() => host.ctx.developmentRooms.list().participants.some(value => value.id === participant), polling).toBe(true)
    await host.ctx.developmentTasks.checkout({ taskId: personalTask.id, participantId: participant, sessionLabel: responsibility })
    await run(host, agent)
    const assignment = (await host.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (assignment === null) throw new Error('Recipient original Task missing')
    const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: host.peerId,
      ownerAddress, expiresAt: limits.expiresAt, responsibility })
    await host.ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null,
      localTask: { taskId: assignment.taskId, taskBindingId: assignment.bindingId,
        expectedBindingEpoch: assignment.expectedBindingEpoch } })
    host.ctx.on('llm/stream', async function* (options, next) {
      const requestStartedMs = performance.now() - started
      const messages = structuredClone(options.messages)
      const events = structuredClone(agent.session.snapshotEvents())
      expect(Session.create(agent.id, events, agent.session.header).deriveMessages()).toEqual(messages)
      expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
      const disk = await host.readEvents(agent)
      expect(disk).toEqual(events)
      expect(Session.create(agent.id, structuredClone([...disk]), agent.session.header).deriveMessages()).toEqual(messages)
      const managed = messages.filter(message => message.source.kind === 'scope-agent-context'
        || message.source.kind === 'development-task-context')
      const managedBytes = managed.flatMap(message => message.content)
        .reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
      expect(managedBytes).toBeLessThanOrEqual(8000)
      const remote = messages.flatMap(message => message.source.kind === 'scope-agent-context' && message.source.form === 'snapshot'
        ? [message.source.projection] : [])
      expect(remote).toHaveLength(1)
      const projection = remote[0]
      if (projection === undefined) throw new Error('Actual request has no active remote projection')
      expect(projection.backend).toEqual({ id: 'reported-files', revision: '3' })
      const selectedIds = projection.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
      const policyDelivered = policySources.every(id => selectedIds.includes(id))
      const commandDelivered = selectedIds.includes(commandSource)
      if (phase !== 'mixed') {
        expect(policyDelivered).toBe(true)
        expect(commandDelivered).toBe(true)
      }
      if (phase !== 'initial') expect(projection.text).not.toContain('CHECK_INITIAL_OK')
      expect(projection.text).not.toContain('MIXED_PRIVATE_CHECK_IMPLEMENTATION')
      const view = await owner.ctx.developmentTasks.currentContextView(task.id)
      expect(projection.taskRevision).toBe(view.task.revision)
      const coveredIds = [...selectedIds, ...projection.omittedSources.flatMap(value => value.source.kind === 'publication'
        ? [value.source.publicationId] : [])]
      expect(coveredIds.toSorted()).toEqual(view.task.context.map(value => value.id).toSorted())
      requests.push({ role, phase, requestStartedMs, header: agent.session.header, events, disk, messages, view,
        projection, managedBytes, recipient: { participantId: `scope-recipient-${invitation.grantId}`, sessionLabel: responsibility },
        localParticipantId: participant, remoteOfferBytes: projection.maxContextBytes, policySources: [...policySources], commandSource })
      summary.push({ role, phase, managedBytes, policyDelivered, commandDelivered, selected: selectedIds.length,
        budgetOmissions: projection.omittedSources.filter(value => value.reason === 'budget').length })
      yield* next()
    })
    receivers.push({ host, agent, role, participantId: participant, sessionLabel: responsibility,
      backendParticipantId: `scope-recipient-${invitation.grantId}` })
  }
  expect(new Set(hosts.map(host => host.root)).size).toBe(4)
  expect(new Set(hosts.map(host => host.peerId)).size).toBe(4)
  const context = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
  const localReports = () => context().filter(value => value.localToolObservation !== undefined)
  const peerReports = () => context().filter(value => value.peerToolObservation !== undefined)
  const receipts = async (source: 'local' | 'peer', count: number) => {
    await expect.poll(() => (source === 'local' ? localReports() : peerReports()).length, polling).toBe(count)
    await expect.poll(async () => source === 'local'
      ? (await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })).capture?.pendingSamples
      : (await peer.ctx.scopeAgentContributions.status({ agentId: documentAuthor.id })).capture?.pendingSamples, polling).toBe(0)
    timeline.push({ event: 'receipt-confirmed', source, count, elapsedMs: performance.now() - started })
  }
  const readRecipients = async () => {
    policySources = localReports().filter(value => value.localToolObservation?.kind === 'tool-observation')
      .map(value => value.id)
    const latest = localReports().filter(value => value.localToolObservation?.kind === 'command-observation').at(-1)
    if (latest === undefined || policySources.length === 0) throw new Error('Critical actual reports missing')
    commandSource = latest.id
    for (const receiver of receivers) await run(receiver.host, receiver.agent)
  }
  await writeFile(join(owner.workspace, 'verify.cjs'), checkSource, { flag: 'wx' })
  await writeFile(join(owner.workspace, 'check-state.json'), JSON.stringify({ code: 0, output: 'CHECK_INITIAL_OK\n' }), { flag: 'wx' })
  await run(owner, author, [toolCallResponse('policy-initial', 'write', { file_path: 'policy.md', content: initialPolicy }),
    toolCallResponse('check-initial', 'bash', { command, description: 'Run the authorized payment compatibility check.' })])
  timeline.push({ event: 'source-turn-completed', phase, elapsedMs: performance.now() - started })
  await receipts('local', 2)
  expect(localReports()[1]?.localToolObservation).toMatchObject({ kind: 'command-observation', state: 'completed', exitCode: 0 })
  await readRecipients()

  phase = 'corrected'
  await writeFile(join(owner.workspace, 'check-state.json'), JSON.stringify({ code: 7, output: 'CHECK_CURRENT_FAILED\n' }))
  await run(owner, author, [toolCallResponse('policy-corrected', 'edit',
    { file_path: 'policy.md', old_string: 'maxRetries: 3', new_string: 'maxRetries: 1' }),
  toolCallResponse('check-corrected', 'bash', { command, description: 'Run the authorized payment compatibility check.' })])
  timeline.push({ event: 'source-turn-completed', phase, elapsedMs: performance.now() - started })
  await receipts('local', 4)
  expect(localReports()[3]?.localToolObservation).toMatchObject({ kind: 'command-observation', state: 'completed', exitCode: 7,
    stdout: { state: 'included', text: 'CHECK_CURRENT_FAILED\n' } })
  expect(await readFile(join(owner.workspace, 'policy.md'), 'utf8')).toBe(correctedPolicy)
  await readRecipients()

  const documentContents = documents.map(([path, title, paragraphs]) => ({ path, content: title + paragraphs.join('\n\n') + '\n' }))
  for (const [index, document] of documentContents.entries()) {
    expect(Buffer.byteLength(document.content)).toBeGreaterThan(800)
    expect(Buffer.byteLength(document.content)).toBeLessThan(1400)
    await run(peer, documentAuthor, [toolCallResponse(`document-${index}`, 'write', { file_path: document.path, content: document.content })])
    await receipts('peer', index + 1)
  }
  const first = documentContents[0]
  if (first === undefined) throw new Error('Document fixture missing')
  const replacement = first.content.replace('weekly asset review', 'monthly asset review')
  await run(peer, documentAuthor, [toolCallResponse('document-overwrite', 'write', { file_path: first.path, content: replacement })])
  await receipts('peer', 4)
  phase = 'mixed'
  await readRecipients()
  expect(summary).toHaveLength(6)
  const sourceFiles = { policy: await readFile(join(owner.workspace, 'policy.md'), 'utf8'), documents: await Promise.all(
    documentContents.map(async (document, index) => {
      const content = await readFile(join(peer.workspace, document.path), 'utf8')
      expect(content).toBe(index === 0 ? replacement : document.content)
      return { path: document.path, content, bytes: Buffer.byteLength(content) }
    })) }
  for (const receiver of receivers) {
    expect(receiver.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
  }
  const sourceEvents = { owner: await owner.readEvents(author), peer: await peer.readEvents(documentAuthor) }
  const calls = { owner: sourceEvents.owner.filter(event => event.type === 'tool/call').map(event => event.data.name),
    peer: sourceEvents.peer.filter(event => event.type === 'tool/call').map(event => event.data.name) }
  expect(calls.owner).toEqual(['write', 'bash', 'edit', 'bash'])
  expect(calls.peer).toEqual(['write', 'write', 'write', 'write'])
  const canonicalWorkspace = await realpath(owner.workspace)
  expect(commandOutcomes.map(value => ({ command: value.command, workdir: value.workdir, exitCode: value.exitCode })))
    .toEqual([0, 7].map(exitCode => ({ command, workdir: canonicalWorkspace, exitCode })))
  const finalAuthorizedView = await owner.ctx.developmentTasks.currentContextView(task.id)
  let artifact = process.env.DSH_MIXED_WORKLOAD_ARTIFACTS
  if (artifact === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mixed-workload-evidence-'))
    temporaryArtifacts.push(root)
    artifact = join(root, 'measurement.json')
  }
  await writeFile(artifact, JSON.stringify({ kind: 'keyless-mechanism-measurement', backend: 'reported-files/3',
    contextBudgetBytes: 8000, hosts: hosts.map(host => ({ peerId: host.peerId, workspace: host.workspace })),
    sourceFiles, sourceEvents, commandOutcomes, finalAuthorizedView,
    recipients: receivers.map(({ role, participantId, sessionLabel, backendParticipantId }) => ({
      role, localParticipantId: participantId, recipient: { participantId: backendParticipantId, sessionLabel },
    })), timeline, requests, summary }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.info('mixed-workload measurement', JSON.stringify({ artifact, summary, actualToolCounts: { owner: calls.owner.length, peer: calls.peer.length },
    modelBenefitMeasured: false, transport: 'in-process' }))
})
