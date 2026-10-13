/** Real native source tools and ordinary HTTP-provider Agents working on bounded JSON artifacts. */
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { launchNativeHost } from './native-run.ts'
import { resolveNativeModules } from './native-dependencies.ts'
import { sealDataArtifact, type SealedDataArtifact, type DataArtifactGrades } from './data-artifacts.ts'
import type { NativeDataStudy } from './data-study.ts'
import { observationSchema, captureSchema, taskSchema, projectionMessageSchema, errorText, save, project, coordinator, until,
  environment, sqliteRows, sealedFile, verifyReceipts, type Recipient } from './native-data-common.ts'

/** One current-work checkpoint in the same live receiving Session. */
export type NativeDataContinuityPhase = 'initial' | 'corrected' | 'withdrawn'
/** Explicit finite automatic permission and parent-only phase grading. */
export interface NativeDataContinuity {
  readonly decisionPath: string
  readonly automatic: { readonly activationLimit: number; readonly maxStepsPerTurn: number; readonly minIntervalMs: number }
  readonly grade?: (phase: NativeDataContinuityPhase, artifacts: {
    readonly policy: SealedDataArtifact | null
    readonly decision: SealedDataArtifact | null
    readonly previousPolicy: SealedDataArtifact | null
  }) => unknown
}
/** Sealed phase evidence; the same Session and original receiving permission span every phase. */
export interface NativeDataContinuityResult {
  readonly phase: NativeDataContinuityPhase
  readonly ownerRevision: number
  readonly agentId: string
  readonly sessionId: string
  readonly requestStart: number
  readonly requestEnd: number
  readonly scopeState: unknown
  readonly subscription: unknown
  readonly completed: unknown
  readonly durable: unknown
  readonly artifacts: { readonly policy: SealedDataArtifact | null; readonly decision: SealedDataArtifact | null }
  readonly grade: unknown
}

/** Explicit execution provenance; calibration still exercises the production HTTP adapter. */
export interface NativeDataRunRequest {
  readonly repo: string
  readonly nodePath: string
  readonly output: string
  readonly condition: 'N' | 'E' | 'R'
  readonly study: NativeDataStudy
  readonly execution: { readonly kind: 'live' | 'transport-calibration' }
  readonly signal?: AbortSignal
  readonly continuity?: NativeDataContinuity
  readonly grade?: (artifacts: {
    readonly policy: SealedDataArtifact | null
    readonly cases: SealedDataArtifact | null
  }) => DataArtifactGrades | Promise<DataArtifactGrades>
}
/** Independent observations of one ordinary Session; a completed turn is not an artifact score. */
export interface NativeDataRoleResult {
  readonly requests: number
  readonly turnReason: unknown
  readonly scopeSnapshots: number
  readonly adoptedWatermark: boolean
  readonly durable: unknown
  readonly publicChecks: readonly unknown[]
  readonly skipped: boolean
  readonly completed: boolean
}
/** Native execution and sealed artifacts, with explicit partial failure and subsequent-dispatch policy. */
export interface NativeDataRunResult {
  readonly kind: 'native-data-run'
  readonly condition: 'N' | 'E' | 'R'
  readonly execution: NativeDataRunRequest['execution']
  readonly failed: boolean
  readonly error: string | null
  readonly dispatchBlocked: boolean
  readonly realModelDispatches: number
  readonly counts: { readonly ordinary: number; readonly semantic: number; readonly sourceControlled: number }
  readonly modelCounterMeaning: string
  readonly ownerRevision: number | null
  readonly peers: readonly string[]
  readonly roles: Readonly<Partial<Record<'B' | 'C', NativeDataRoleResult>>>
  readonly artifacts: { readonly policy: SealedDataArtifact | null; readonly cases: SealedDataArtifact | null }
  readonly grade: unknown
  readonly cleanup: { readonly started: number; readonly closed: number; readonly forced: number }
  readonly continuity?: { readonly phases: readonly NativeDataContinuityResult[] }
}



type DataHost = Awaited<ReturnType<typeof launchNativeHost>>
type DataConnection = Awaited<ReturnType<DataHost['connect']>>
const continuityStatusSchema = z.object({ agentId: z.string(), sessionId: z.string(), agentStatus: z.string(),
  requests: z.number(), lastTurnEnd: z.object({ seq: z.number(), data: z.object({ reason: z.unknown() }).loose() }).loose().nullable(),
  completed: z.object({ request: z.object({ projection: z.object({ taskRevision: z.number() }).loose() }).loose(),
    requestSeq: z.number(), turnEndSeq: z.number() }).loose().nullable(),
  scopeState: z.object({ binding: z.object({ id: z.string(), subscriptionId: z.string() }).loose().nullable(),
    automatic: z.unknown(), usedBudget: z.number(), mode: z.string(), pauseReason: z.string().nullable() }).loose(),
}).loose()
async function runContinuity(input: {
  request: NativeDataRunRequest
  continuity: NativeDataContinuity
  source: DataConnection
  owner: DataConnection
  receiver: DataConnection
  sourceHost: DataHost
  ownerHost: DataHost
  receiverHost: DataHost
  sourceId: string
  sourceProject: string
  taskId: string
  address: string
  server: Awaited<ReturnType<typeof coordinator>>
  target: Recipient
  signal: AbortSignal
  phases: NativeDataContinuityResult[]
  onSourceRequests: (count: number) => void
  onRevision: (revision: number) => void
}): Promise<{ ownerRevision: number; sourceControlled: number; role: NativeDataRoleResult; policy: SealedDataArtifact | null }> {
  const { request, continuity, source, owner, receiver, sourceHost, ownerHost, receiverHost, sourceId,
    sourceProject, taskId, address, server, target, signal, phases } = input
  const current = () => owner.rpc('developmentTasks/get', { request: { taskId } }).then(value => taskSchema.parse(value))
  const capture = () => source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } }).then(value => captureSchema.parse(value))
  const receiverId = z.object({ agentId: z.string() }).parse(await receiver.native('status')).agentId
  let previousRequests = 0
  let binding: unknown
  let lastObservation: z.infer<typeof observationSchema> | undefined
  let lastRevision = 0
  let sourceControlled = 0
  const sourceCheckpoint = async (phase: 'initial' | 'corrected', count: number) => {
    const task = await until(current, value => value.context.length === count, signal)
    await until(capture, value => value.capture?.pendingSamples === 0, signal)
    if (phase === 'corrected') await until(async () => z.object({ agentStatus: z.string() }).loose().parse(await source.native('status')),
      value => value.agentStatus === 'idle', signal)
    const observation = observationSchema.parse(await source.native('finish'))
    sourceControlled = observation.requests.length
    input.onSourceRequests(sourceControlled)
    const sourceRows = sqliteRows(join(sourceHost.directory, 'state.sqlite'), 'u_scope_agent_contributions_sessions')
    const ownerEvents = sqliteRows(join(ownerHost.directory, 'state.sqlite'), 'u_development_context_tasks_events')
    verifyReceipts(observation, sourceRows, ownerEvents, source.identity.peerId, owner.identity.peerId, count)
    const sourceTasks = z.array(taskSchema).parse(await source.rpc('developmentTasks/list', { request: { limit: 1 } }))
    if (sourceTasks.length !== 0) throw new Error('source received a Task replica')
    const reports = task.context.map(value => z.object({ peerToolObservation:
      z.object({ tool: z.string(), reportedStatus: z.string() }).loose() }).loose().parse(value).peerToolObservation)
    const expected = phase === 'initial' ? [['Write', 'success']] : [['Write', 'success'], ['Edit', 'success'], ['Edit', 'failure']]
    if (!isDeepStrictEqual(reports.map(item => [item.tool, item.reportedStatus]), expected)) throw new Error('continuity source tool trajectory differs')
    const expectedText = phase === 'initial' ? request.study.source.initialContent : request.study.source.expectedContent
    if (await readFile(join(sourceProject, request.study.source.path), 'utf8') !== expectedText) throw new Error('continuity actual source file differs')
    await save(request.output, `${phase}-source-admission.json`, { sourceRows, ownerEvents, task, reports, sourceTaskReplicas: 0 })
    await save(request.output, `${phase}-A-session.json`, observation)
    await cp(join(sourceHost.directory, 'sessions'), join(request.output, `${phase}-A-durable-sessions`), { recursive: true })
    return task
  }
  const checkpoint = async (phase: NativeDataContinuityPhase, task: z.infer<typeof taskSchema>) => {
    lastRevision = task.revision
    input.onRevision(lastRevision)
    server.setWatermark({ taskId, revision: task.revision, condition: request.condition })
    server.openAdmission()
    const status = await until(async () => {
      const value = continuityStatusSchema.parse(await receiver.native('status'))
      if (value.scopeState.mode === 'paused' && value.scopeState.pauseReason !== 'budget') {
        throw new Error(`continuity automatic work paused: ${value.scopeState.pauseReason}: ${JSON.stringify(value.lastTurnEnd)}`)
      }
      if (server.failedAccounting() && value.agentStatus === 'idle') throw new Error('continuity accounting blocks the next phase')
      return value
    }, value => value.agentStatus === 'idle' && value.completed?.request.projection.taskRevision === task.revision
      && value.requests > previousRequests && value.lastTurnEnd?.seq === value.completed.turnEndSeq, signal)
    const observation = observationSchema.parse(await receiver.native('finish'))
    if (!z.object({ kind: z.literal('completed') }).safeParse(observation.turnReason).success) throw new Error('continuity turn did not complete')
    const state = status.scopeState
    if (state.binding === null || state.usedBudget !== phases.length + 1) throw new Error('continuity binding or cumulative reservation count differs')
    if (binding === undefined) binding = state.binding
    else if (!isDeepStrictEqual(binding, state.binding)) throw new Error('continuity changed the original read binding')
    if (!isDeepStrictEqual(state.automatic, { goal: target.spec.goal, ...continuity.automatic })) throw new Error('continuity changed automatic permission')
    const inventory = z.object({ subscriptions: z.array(z.object({ id: z.string(), state: z.string() }).loose()) }).loose().parse(await receiver.rpc('scopeAccess/list'))
    const subscription = inventory.subscriptions.find(item => item.id === state.binding?.subscriptionId)
    if (subscription?.state !== 'active') throw new Error('source withdrawal changed independent read permission')
    const fresh = observation.requests.slice(previousRequests)
    for (const item of fresh) {
      const snapshots = item.messages.flatMap((message) => {
        const parsed = projectionMessageSchema.safeParse(message)
        return parsed.success && parsed.data.source.kind === 'scope-agent-context' && parsed.data.source.form === 'snapshot' ? [parsed.data.source] : []
      })
      if (snapshots.length !== 1 || snapshots[0]?.projection?.taskRevision !== task.revision
        || snapshots[0].projection.backend.id !== (request.condition === 'R' ? 'semantic' : 'text')) throw new Error('continuity request raced its phase watermark')
    }
    const userPrompts = observation.events.filter(event => event.type === 'user/message'
      && z.object({ source: z.object({ kind: z.string() }).loose() }).loose().parse(event.data).source.kind === 'user')
    if (userPrompts.length !== 0) throw new Error('continuity injected a manual user prompt')
    const artifacts = { policy: await sealedFile(target, target.spec.artifactPath, signal),
      decision: await sealedFile(target, continuity.decisionPath, signal) }
    const phaseGrade = continuity.grade === undefined ? null : await continuity.grade(phase, { ...artifacts,
      previousPolicy: phases.at(-1)?.artifacts.policy ?? null })
    const record: NativeDataContinuityResult = { phase, ownerRevision: task.revision, agentId: status.agentId,
      sessionId: status.sessionId, requestStart: previousRequests, requestEnd: observation.requests.length,
      scopeState: state, subscription, completed: status.completed, durable: observation.durable, artifacts, grade: phaseGrade }
    await save(request.output, `${phase}-B-session.json`, observation)
    await cp(join(receiverHost.directory, 'sessions'), join(request.output, `${phase}-B-durable-sessions`), { recursive: true })
    await save(request.output, `${phase}-sealed.json`, record)
    phases.push(record)
    previousRequests = observation.requests.length
    lastObservation = observation
    server.closeAdmission()
  }
  try {
    await until(() => Promise.resolve(server.sourceWaiting()), Boolean, signal)
    const initial = await sourceCheckpoint('initial', 1)
    server.setWatermark({ taskId, revision: initial.revision, condition: request.condition })
    const invitation = await owner.rpc('scopeAccess/invite', { request: { taskId, ownerAddress: address,
      recipientPeerId: receiver.identity.peerId, expiresAt: Date.now() + request.study.limits.wallTimeoutMs,
      responsibility: 'Maintain payment client configuration and current-work availability from authorized policy reports.' } })
    await receiver.rpc('scopeAgentContext/bind', { request: { agentId: receiverId, expectedBindingId: null,
      invitation, automatic: { goal: target.spec.goal, ...continuity.automatic } } })
    await checkpoint('initial', initial)
    server.releaseSource()
    const corrected = await sourceCheckpoint('corrected', 3)
    await checkpoint('corrected', corrected)
    const selected = (await capture()).capture
    if (selected === null) throw new Error('source capture missing before explicit stop')
    await source.rpc('scopeAgentContributions/stop', { request: { agentId: sourceId, expectedCapture: selected.selection } })
    await until(capture, value => value.capture === null, signal)
    const ended = await until(current, value => value.context.some(item => z.object({ peerContribution: z.object({ ended: z.enum(['revoked', 'left', 'expired']) }).loose() }).safeParse(item).success), signal)
    const terminalEvents = sqliteRows(join(ownerHost.directory, 'state.sqlite'), 'u_development_context_tasks_events')
    await save(request.output, 'withdrawn-source-admission.json', { task: ended, ownerEvents: terminalEvents,
      sourceRows: sqliteRows(join(sourceHost.directory, 'state.sqlite'), 'u_scope_agent_contributions_sessions') })
    await checkpoint('withdrawn', ended)
    if (lastObservation === undefined) throw new Error('continuity never completed a receiving turn')
    const final = lastObservation
    return { ownerRevision: lastRevision, sourceControlled, policy: phases.at(-1)?.artifacts.policy ?? null,
      role: { requests: final.requests.length, turnReason: final.turnReason, scopeSnapshots: final.requests.length,
        adoptedWatermark: true, durable: final.durable, publicChecks: target.checks, skipped: false, completed: true } }
  } catch (error) {
    await receiver.native('cancel').catch(() => undefined)
    await save(request.output, 'continuity-failure.json', { error: errorText(error), phases: phases.length,
      status: await receiver.native('status').catch(() => null) })
    const partial = await receiver.native('finish').catch(() => null)
    if (partial !== null) await save(request.output, 'partial-B-session.json', partial)
    await cp(join(receiverHost.directory, 'sessions'), join(request.output, 'partial-B-durable-sessions'), { recursive: true }).catch(() => undefined)
    throw error
  }
}

/** Execute a four-Host post-update wave or three-Host E/R continuity trial; generated artifact code is never executed.
 * @param request Frozen projects and model routes, optional continuous automatic permission, and parent-only artifact grading.
 * @returns Actual requests, durable admission, sealed wave or phase artifacts, and awaited cleanup, including failed trials.
 */
export async function runNativeData(request: NativeDataRunRequest): Promise<NativeDataRunResult> {
  if (request.continuity !== undefined && (request.condition === 'N'
    || !request.study.roles.B.writableFiles.includes(request.continuity.decisionPath)
    || !request.study.roles.B.readableFiles.includes(request.continuity.decisionPath))) {
    throw new Error('continuity requires E/R and an explicitly allowed current-work file')
  }
  const modelEnvironments = { ordinary: environment(request.study.ordinary, request.execution),
    semantic: request.condition === 'R' ? environment(request.study.semantic, request.execution) : {} }
  await mkdir(request.output, { recursive: false, mode: 0o700 })
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'scope-native-data-')))
  const lifetime = new AbortController()
  const cancelled = () => { lifetime.abort(request.signal?.reason ?? new Error('data study cancelled')) }
  request.signal?.addEventListener('abort', cancelled, { once: true })
  if (request.signal?.aborted === true) cancelled()
  const timer = setTimeout(() => { lifetime.abort(new Error('data run wall deadline exceeded')) }, request.study.limits.wallTimeoutMs)
  const hosts: Awaited<ReturnType<typeof launchNativeHost>>[] = []
  const cleanup = { started: 0, closed: 0, forced: 0 }
  let server: Awaited<ReturnType<typeof coordinator>> | undefined
  let failure: unknown; let ownerRevision: number | null = null; let sourceControlled = 0
  const peers: string[] = []; const roles: Partial<Record<'B' | 'C', NativeDataRoleResult>> = {}
  const artifacts: { policy: SealedDataArtifact | null; cases: SealedDataArtifact | null } = { policy: null, cases: null }
  let grade: unknown = null
  const phases: NativeDataContinuityResult[] = []
  try {
    lifetime.signal.throwIfAborted()
    const study = request.study
    const recipients = { B: await project(temporary, 'B', study), C: await project(temporary, 'C', study) }
    server = await coordinator(request.output, recipients, study, lifetime.signal, request.continuity !== undefined)
    const modules = resolveNativeModules(request.repo)
    const connections: Awaited<ReturnType<Awaited<ReturnType<typeof launchNativeHost>>['connect']>>[] = []
    const sourceProject = join(temporary, 'source-project')
    await mkdir(sourceProject, { mode: 0o700 })
    const selectedRoles = request.continuity === undefined ? ['A', 'O', 'B', 'C'] as const : ['A', 'O', 'B'] as const
    for (const role of selectedRoles) {
      const route = role === 'O' ? study.semantic : study.ordinary
      const target = role === 'B' || role === 'C' ? recipients[role] : undefined
      const shared = { role, sessionId: `data-${role}`, project: target?.project ?? sourceProject,
        sessionRoot: join(temporary, `host-${role}`, 'sessions'), coordinatorUrl: server.url,
        coordinatorToken: server.tokens[role], route, contextBytes: study.limits.contextBytes,
        operationTimeoutMs: study.limits.operationTimeoutMs, maxToolBytes: 262144, continuity: request.continuity !== undefined }
      const native = role === 'O' ? undefined : role === 'A' ? { ...shared, mode: 'data-source',
        goal: 'Apply the scripted local policy write and correction, and record the failed edit without claiming success.',
        program: [
          { name: 'read', args: { file_path: study.source.path } },
          { name: 'write', args: { file_path: study.source.path, content: study.source.initialContent } },
          { name: 'read', args: { file_path: study.source.path } },
          { name: 'edit', args: { file_path: study.source.path, old_string: study.source.correction.oldString, new_string: study.source.correction.newString } },
          { name: 'read', args: { file_path: study.source.path } },
          { name: 'edit', args: { file_path: study.source.path, old_string: study.source.failedEdit.oldString, new_string: study.source.failedEdit.newString } },
        ] } : { ...shared, mode: 'data-recipient', ...target?.spec }
      const host = await launchNativeHost(temporary, role, { ...request, cleanupTimeoutMs: study.limits.cleanupTimeoutMs,
        environment: role === 'A' ? {} : role === 'O' ? modelEnvironments.semantic : modelEnvironments.ordinary }, modules, native,
      { ...shared, condition: request.condition, peerTimeoutMs: study.semantic.timeoutMs + study.limits.operationTimeoutMs })
      hosts.push(host); cleanup.started++
      connections.push(await host.connect(lifetime.signal))
    }
    const [source, owner, frontend, qa] = connections
    const [sourceHost, ownerHost, receiverHost] = hosts
    if (!source || !owner || !frontend || !sourceHost || !ownerHost || !receiverHost || request.continuity === undefined && !qa) throw new Error('independent Hosts missing')
    peers.push(...connections.map(item => item.identity.peerId))
    if (new Set(peers).size !== selectedRoles.length || new Set(hosts.map(host => host.process.pid)).size !== selectedRoles.length) throw new Error('Host identities overlap')
    const address = owner.identity.addresses[0]
    if (address === undefined) throw new Error('owner address missing')
    await owner.rpc('developmentRooms/announce', { request: { id: 'data-owner', kind: 'human', displayName: 'Data study owner' } })
    const created = z.object({ task: taskSchema }).loose().parse(await owner.rpc('developmentTasks/create', { request: {
      origin: { kind: 'root' }, objective: 'Maintain payment client configuration and independent QA acceptance cases.',
      scope: 'Authorized native policy file work reports.', createdBy: 'data-owner' } }))
    const entry = z.object({ entry: z.object({ entryId: z.string() }).loose() }).loose().parse(
      await owner.rpc('scopeAccess/createContributionEntry', { request: { taskId: created.task.id, sourceKind: 'tool-observations',
        ownerAddress: address, expiresAt: Date.now() + study.limits.wallTimeoutMs } }))
    const sourceId = z.object({ agentId: z.string() }).loose().parse(await source.native('status')).agentId
    const limits = { expiresAt: Date.now() + study.limits.wallTimeoutMs, maxSamples: 3, maxSampleBytes: 16384 }
    const requested = captureSchema.parse(await source.rpc('scopeAgentContributions/request', { request: {
      agentId: sourceId, expectedCapture: null, entry: entry.entry, roots: [sourceProject], tools: ['write', 'edit'], limits } }))
    if (requested.capture === null) throw new Error('source consent missing')
    await until(() => owner.rpc('scopeAccess/contributionApplications', { request: { taskId: created.task.id } }),
      value => JSON.stringify(value).includes('"status":"pending"'), lifetime.signal)
    await owner.rpc('scopeAccess/approveContributionApplication', { request: { entryId: entry.entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress: address } })
    await until(async () => captureSchema.parse(await source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } })),
      value => value.capture?.collecting === true, lifetime.signal)
    await source.native('start')
    if (request.continuity !== undefined) {
      const continuity = request.continuity
      const phaseResult = await runContinuity({ request, continuity, source, owner, receiver: frontend,
        sourceHost, ownerHost, receiverHost, sourceId, sourceProject, taskId: created.task.id,
        address, server, target: recipients.B, signal: lifetime.signal, phases,
        onSourceRequests: (count) => { sourceControlled = count }, onRevision: (revision) => { ownerRevision = revision } })
      ownerRevision = phaseResult.ownerRevision
      sourceControlled = phaseResult.sourceControlled
      roles.B = phaseResult.role
      artifacts.policy = phaseResult.policy
    } else {
      const sourceObservation = observationSchema.parse(await source.native('finish'))
      sourceControlled = sourceObservation.requests.length
      const current = await until(async () => taskSchema.parse(await owner.rpc('developmentTasks/get', { request: { taskId: created.task.id } })),
        value => value.context.length === 3, lifetime.signal)
      ownerRevision = current.revision
      await until(async () => captureSchema.parse(await source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } })),
        value => value.capture?.pendingSamples === 0, lifetime.signal)
      const sourceTasks = z.array(taskSchema).parse(await source.rpc('developmentTasks/list', { request: { limit: 1 } }))
      if (sourceTasks.length !== 0) throw new Error('source received a Task replica')
      const reports = current.context.map(value => z.object({ peerToolObservation:
        z.object({ tool: z.string(), reportedStatus: z.string() }).loose() }).loose().parse(value).peerToolObservation)
      if (!isDeepStrictEqual(reports.map(item => [item.tool, item.reportedStatus]), [['Write', 'success'], ['Edit', 'success'], ['Edit', 'failure']])) {
        throw new Error('source trajectory is not Write success, Edit success, Edit failure')
      }
      if (await readFile(join(sourceProject, study.source.path), 'utf8') !== study.source.expectedContent) throw new Error('actual source file differs')
      const sourceRows = sqliteRows(join(sourceHost.directory, 'state.sqlite'), 'u_scope_agent_contributions_sessions')
      const ownerEvents = sqliteRows(join(ownerHost.directory, 'state.sqlite'), 'u_development_context_tasks_events')
      verifyReceipts(sourceObservation, sourceRows, ownerEvents, source.identity.peerId, owner.identity.peerId, 3)
      server.setWatermark({ taskId: current.id, revision: current.revision, condition: request.condition })
      await save(request.output, 'source-admission.json', { sourceRows, ownerEvents, task: current, reports, sourceTaskReplicas: sourceTasks.length })
      await save(request.output, 'A-session.json', sourceObservation)
      await cp(join(sourceHost.directory, 'sessions'), join(request.output, 'A-durable-sessions'), { recursive: true })
      if (qa === undefined) throw new Error('QA Host missing')
      for (const [role, receiver] of [['B', frontend], ['C', qa]] as const) {
        if (server.blocked() || Object.values(roles).some(value => !value.completed)) {
          roles[role] = { requests: 0, turnReason: null, scopeSnapshots: 0, adoptedWatermark: false,
            durable: null, publicChecks: [], skipped: true, completed: false }; continue
        }
        const status = z.object({ agentId: z.string() }).loose().parse(await receiver.native('status'))
        if (request.condition !== 'N') {
          const invitation = await owner.rpc('scopeAccess/invite', { request: { taskId: current.id, ownerAddress: address,
            recipientPeerId: receiver.identity.peerId, expiresAt: Date.now() + study.limits.wallTimeoutMs,
            responsibility: role === 'B' ? 'Maintain payment client configuration; preserve exact retry limits and failure semantics.'
              : 'Maintain independent QA acceptance cases; cover corrections, validation, retry limits, and failed tool attempts.' } })
          await receiver.rpc('scopeAgentContext/bind', { request: { agentId: status.agentId, expectedBindingId: null, invitation, automatic: null } })
        }
        await receiver.native('start')
        const observation = observationSchema.parse(await receiver.native('finish'))
        const snapshots = observation.requests.flatMap(item => item.messages.map(message => projectionMessageSchema.safeParse(message))
          .flatMap(value => value.success && value.data.source.kind === 'scope-agent-context' && value.data.source.form === 'snapshot' ? [value.data.source] : []))
        const firstSources = observation.requests[0]?.messages.flatMap((message) => {
          const parsed = projectionMessageSchema.safeParse(message)
          return parsed.success && parsed.data.source.kind === 'scope-agent-context' && parsed.data.source.form === 'snapshot'
            ? [parsed.data.source] : []
        }) ?? []
        const adoptedWatermark = firstSources.some(item => item.projection?.taskRevision === ownerRevision
          && item.projection.backend.id === (request.condition === 'R' ? 'semantic' : 'text'))
        if (request.condition === 'N' && snapshots.length !== 0) throw new Error('N received shared context')
        if (request.condition !== 'N' && observation.requests.length > 0 && !adoptedWatermark) {
          throw new Error('recipient dispatched without selected owner watermark/backend')
        }
        const target = recipients[role]
        const artifact = await target.workbench.read(target.spec.artifactPath, lifetime.signal)
          .then(value => sealDataArtifact(value.text), (error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
            throw error
          })
        if (role === 'B') artifacts.policy = artifact; else artifacts.cases = artifact
        roles[role] = { requests: observation.requests.length, turnReason: observation.turnReason, scopeSnapshots: snapshots.length,
          adoptedWatermark, durable: observation.durable, publicChecks: target.checks, skipped: false,
          completed: z.object({ kind: z.literal('completed') }).safeParse(observation.turnReason).success }
        await save(request.output, `${role}-session.json`, observation)
        await cp(join(temporary, `host-${role}`, 'sessions'), join(request.output, `${role}-durable-sessions`), { recursive: true })
      }
    }
    if (request.condition === 'R') {
      await save(request.output, 'semantic-audit.json', await owner.native('finish'))
      await cp(join(ownerHost.directory, 'sessions'), join(request.output, 'semantic-durable-sessions'), { recursive: true })
    }
    await save(request.output, 'sealed-artifacts.json', artifacts)
    grade = request.continuity === undefined && request.grade !== undefined ? await request.grade(artifacts) : null
    lifetime.signal.throwIfAborted()
  } catch (error) { failure = error } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', cancelled)
    lifetime.abort(new Error('native data run complete'))
    if (server !== undefined) await server.close().catch((error: unknown) => { failure ??= error })
    for (const host of hosts.reverse()) {
      try { const ended = await host.stop(); cleanup.closed++; if (ended.signal === 'SIGKILL') cleanup.forced++
        await save(request.output, `host-${cleanup.closed}-exit.json`, { code: ended.code, signal: ended.signal,
          stdoutBytes: Buffer.byteLength(ended.stdout), stderrBytes: Buffer.byteLength(ended.stderr) })
      } catch (error) { failure ??= error }
    }
    await rm(temporary, { recursive: true, force: true })
  }
  if (cleanup.closed !== cleanup.started || cleanup.forced > 0) failure ??= new Error('Host cleanup did not settle normally')
  const reservations = server?.reservations ?? []
  const counts = { ordinary: reservations.filter(item => item.role !== 'O').length,
    semantic: reservations.filter(item => item.role === 'O').length, sourceControlled }
  const result: NativeDataRunResult = { kind: 'native-data-run', condition: request.condition, execution: request.execution,
    failed: failure !== undefined || Object.values(roles).some(role => !role.completed),
    error: failure === undefined ? null : errorText(failure), dispatchBlocked: server?.blocked() ?? false,
    realModelDispatches: request.execution.kind === 'live' ? counts.ordinary + counts.semantic : 0,
    counts, modelCounterMeaning: 'Persisted permission to delegate to the production HTTP adapter; not proof of HTTP-send, billing, or useful model output.',
    ownerRevision, peers, roles, artifacts, grade, cleanup,
    ...request.continuity === undefined ? {} : { continuity: { phases } } }
  await save(request.output, 'dispatch-ledger.json', reservations)
  await save(request.output, 'result.json', result)
  return result
}
