/** Five named dsh Hosts preserve existing local work while admitting one mixed shared-context checkpoint. */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { launchNativeHost } from './native-run.ts'
import { resolveNativeModules } from './native-dependencies.ts'
import { observationSchema, captureSchema, taskSchema, projectionMessageSchema, coordinator, project,
  environment, errorText, save, sealedFile, sqliteRows, until, verifyReceipts, type Recipient } from './native-data-common.ts'
import { observeMixedRequest } from './native-mixed-evidence.ts'
import type { NativeMixedStudy, MixedStudyCondition } from './mixed-study.ts'
import type { SealedDataArtifact } from './data-artifacts.ts'

/** Actual sealed files and parent-observed command visibility, separate from the private grading oracle. */
export interface NativeMixedArtifacts {
  readonly policy: SealedDataArtifact | null
  readonly cases: SealedDataArtifact | null
  readonly verification: Readonly<Record<'B' | 'C', SealedDataArtifact | null>>
  readonly visibleVerification: Readonly<Record<'B' | 'C', number | null>>
}
/** Explicit runtime projects and provider route; no credentials or private oracle are embedded by the driver. */
export interface NativeMixedRunRequest {
  readonly repo: string
  readonly nodePath: string
  readonly output: string
  readonly condition: MixedStudyCondition
  readonly study: NativeMixedStudy
  readonly execution: { readonly kind: 'live' | 'transport-calibration' }
  readonly signal?: AbortSignal
  readonly grade?: (artifacts: NativeMixedArtifacts) => unknown
}
/** One original receiving Session, retaining its local Task across initial, mixed and departed states. */
export interface NativeMixedRoleResult {
  readonly agentId: string
  readonly sessionId: string
  readonly localTaskId: string
  readonly requests: number
  readonly initialRequests: number
  readonly mixedRequests: number
  readonly identityPreserved: boolean
  readonly completed: boolean
  readonly turnReason: unknown
  readonly maxManagedBytes: number
  readonly durable: unknown
  readonly phases: { readonly initial: unknown; readonly mixed: unknown; readonly left: unknown }
}
/** A completed transport trial may still fail business grading; runtime and accounting failures are distinct. */
export interface NativeMixedRunResult {
  readonly kind: 'native-mixed-run'
  readonly condition: MixedStudyCondition
  readonly execution: NativeMixedRunRequest['execution']
  readonly failed: boolean
  readonly error: string | null
  readonly dispatchBlocked: boolean
  readonly realModelDispatches: number
  readonly counts: { readonly ordinary: number; readonly semantic: number; readonly sourceControlled: number }
  readonly modelCounterMeaning: string
  readonly topology: { readonly hosts: 5; readonly responsibilityAgents: 4; readonly transport: 'tcp-noise'; readonly physicalDevices: 1 }
  readonly ownerRevision: number | null
  readonly peers: readonly string[]
  readonly roles: Readonly<Partial<Record<'B' | 'C', NativeMixedRoleResult>>>
  readonly artifacts: NativeMixedArtifacts
  readonly grade: unknown
  readonly cleanup: { readonly started: number; readonly closed: number; readonly forced: number }
}

const observedSession = observationSchema.extend({ sessionId: z.string(), requests: z.array(z.object({
  messages: z.array(z.unknown()), tools: z.array(z.unknown()), eventCount: z.number(),
}).loose()) })
const localStatus = z.object({ assignment: z.object({ taskId: z.string(), bindingId: z.string(),
  expectedBindingEpoch: z.object({ nodeId: z.string(), seq: z.number() }) }).loose().nullable(), capture: z.unknown().nullable() }).loose()
const statusSchema = z.object({ agentId: z.string(), sessionId: z.string(), participantId: z.string(), requests: z.number(),
  local: localStatus, scopeState: z.object({ binding: z.object({ id: z.string() }).loose().nullable(), automatic: z.unknown() }).loose(),
}).loose()
type Host = Awaited<ReturnType<typeof launchNativeHost>>
type Connection = Awaited<ReturnType<Host['connect']>>
type Role = 'B' | 'C'
const continueGoal = 'Continue your existing local responsibility using currently available authorized context. Update your assigned artifacts and verification report when warranted.'

function completed(observation: z.infer<typeof observedSession>): void {
  if (!z.object({ kind: z.literal('completed') }).safeParse(observation.turnReason).success) throw new Error('ordinary turn did not complete')
  for (const event of observation.events) {
    if (event.type !== 'tool/result') continue
    const result = z.object({ error: z.unknown().optional(), message: z.object({ content: z.array(z.object({
      type: z.string(), isError: z.boolean().optional(),
    }).loose()) }).loose() }).loose().parse(event.data)
    if (result.error !== undefined || result.message.content.some(block => block.type === 'tool-result' && block.isError === true)) {
      throw new Error('ordinary artifact tool failed')
    }
  }
}
function sources(messages: readonly unknown[]) {
  return messages.flatMap((message) => {
    const value = projectionMessageSchema.safeParse(message)
    return value.success && value.data.source.kind === 'scope-agent-context' && value.data.source.form === 'snapshot'
      ? [value.data.source.projection] : []
  })
}
async function persistSession(output: string, phase: string, role: string, host: Host, observation: unknown): Promise<void> {
  await save(output, `${phase}-${role}-session.json`, observation)
  await cp(join(host.directory, 'sessions'), join(output, `${phase}-${role}-durable-sessions`), { recursive: true })
}

/** Execute the registered mixed source work after two existing recipients complete their original local turn.
 * @param request Frozen runtime and explicit execution provenance; grading receives only sealed parent observations.
 * @returns Actual phase evidence, cumulative model reservations, business grading and awaited Host cleanup.
 */
export async function runNativeMixed(request: NativeMixedRunRequest): Promise<NativeMixedRunResult> {
  const study = request.study
  const environments = { ordinary: environment(study.ordinary, request.execution),
    semantic: request.condition === 'semantic' ? environment(study.semantic, request.execution) : {} }
  await mkdir(request.output, { recursive: false, mode: 0o700 })
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'scope-native-mixed-')))
  const lifetime = new AbortController()
  const cancelled = () => { lifetime.abort(request.signal?.reason ?? new Error('mixed study cancelled')) }
  request.signal?.addEventListener('abort', cancelled, { once: true })
  if (request.signal?.aborted === true) cancelled()
  const timer = setTimeout(() => { lifetime.abort(new Error('mixed run wall deadline exceeded')) }, study.limits.wallTimeoutMs)
  const hosts = new Map<string, Host>(); const connections = new Map<string, Connection>()
  const cleanup = { started: 0, closed: 0, forced: 0 }
  const roles: Partial<Record<Role, NativeMixedRoleResult>> = {}
  const artifacts = { policy: null as SealedDataArtifact | null, cases: null as SealedDataArtifact | null,
    verification: { B: null as SealedDataArtifact | null, C: null as SealedDataArtifact | null },
    visibleVerification: { B: null as number | null, C: null as number | null } }
  const peers: string[] = []
  let failure: unknown; let grade: unknown = null; let ownerRevision: number | null = null; let sourceControlled = 0
  let server: Awaited<ReturnType<typeof coordinator>> | undefined
  let recipients: Record<Role, Recipient> | undefined
  try {
    lifetime.signal.throwIfAborted()
    recipients = { B: await project(temporary, 'B', study), C: await project(temporary, 'C', study) }
    server = await coordinator(request.output, recipients, study, lifetime.signal, false)
    server.allowInitial()
    const modules = resolveNativeModules(request.repo)
    const sourceProjects = { A: join(temporary, 'policy-source'), D: join(temporary, 'documentation-source') }
    for (const directory of Object.values(sourceProjects)) await mkdir(directory, { mode: 0o700 })
    for (const path of [join(sourceProjects.A, study.source.path),
      ...study.source.documents.map(value => join(sourceProjects.D, value.path))]) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, '', { flag: 'wx', mode: 0o600 })
    }
    const overwrite = study.source.documentOverwrite
    const original = study.source.documents.find(document => document.path === overwrite.path)
    if (original === undefined) throw new Error('registered document overwrite has no source')
    const replaced = original.content.replace(overwrite.oldString, overwrite.newString)
    // Only source-local command execution reads this controlled probe; it is outside admitted roots' tool selection.
    await writeFile(join(sourceProjects.A, 'verify.cjs'),
      'const fs=require("node:fs");const p=".check-count";const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;'
      + 'fs.writeFileSync(p,String(n+1));process.stdout.write(n===0?"CHECK_INITIAL_OK\\n":"CHECK_CURRENT_FAILED\\n");process.exit(n===0?0:7);\n',
      { flag: 'wx', mode: 0o600 })
    const programs = {
      A: [
        { name: 'read', args: { file_path: study.source.path } },
        { name: 'write', args: { file_path: study.source.path, content: study.source.initialContent } },
        { name: 'bash', args: { command: study.source.command, description: 'Run the authorized verification command.' } },
        { name: 'read', args: { file_path: study.source.path } },
        { name: 'edit', args: { file_path: study.source.path, old_string: study.source.correction.oldString, new_string: study.source.correction.newString } },
        { name: 'bash', args: { command: study.source.command, description: 'Run the authorized verification command.' } },
      ],
      D: [...study.source.documents, { path: overwrite.path, content: replaced }].flatMap(document => [
        { name: 'read', args: { file_path: document.path } },
        { name: 'write', args: { file_path: document.path, content: document.content } },
      ]),
    }
    for (const role of ['O', 'A', 'D', 'B', 'C'] as const) {
      const target = role === 'B' || role === 'C' ? recipients[role] : undefined
      const source = role === 'A' || role === 'D'
      const shared = { role, sessionId: `data-${role}`, project: target?.project ?? (source ? sourceProjects[role] : temporary),
        sessionRoot: join(temporary, `host-${role}`, 'sessions'), coordinatorUrl: server.url, coordinatorToken: server.tokens[role],
        route: role === 'O' ? study.semantic : study.ordinary, contextBytes: study.limits.contextBytes,
        operationTimeoutMs: study.limits.operationTimeoutMs, maxToolBytes: 262144, mixed: true, continuity: false }
      const native = role === 'O' ? undefined : source ? { ...shared, mode: 'data-source', program: programs[role],
        goal: 'Perform the registered local file and command work; report actual tool outcomes.' }
        : { ...shared, mode: 'data-recipient', ...target?.spec, continueGoal }
      const host = await launchNativeHost(temporary, role, { ...request, cleanupTimeoutMs: study.limits.cleanupTimeoutMs,
        environment: source ? {} : role === 'O' ? environments.semantic : environments.ordinary }, modules, native,
      { ...shared, condition: request.condition, peerTimeoutMs: study.semantic.timeoutMs + study.limits.operationTimeoutMs })
      hosts.set(role, host); cleanup.started++
      connections.set(role, await host.connect(lifetime.signal))
    }
    const host = (role: string) => { const value = hosts.get(role); if (value === undefined) throw new Error('Host missing'); return value }
    const connection = (role: string) => { const value = connections.get(role); if (value === undefined) throw new Error('connection missing'); return value }
    peers.push(...[...connections.values()].map(value => value.identity.peerId))
    if (new Set(peers).size !== 5 || new Set([...hosts.values()].map(value => value.process.pid)).size !== 5) throw new Error('Host identities overlap')
    const owner = connection('O')
    const address = owner.identity.addresses[0]
    if (address === undefined) throw new Error('scope owner address missing')
    const initial = new Map<Role, {
      status: z.infer<typeof statusSchema>
      observation: z.infer<typeof observedSession>
      target: Recipient
    }>()
    for (const role of ['B', 'C'] as const) {
      const receiver = connection(role)
      const before = statusSchema.parse(await receiver.native('status'))
      await until(() => receiver.rpc('developmentRooms/list'), value => JSON.stringify(value).includes(before.participantId), lifetime.signal)
      const localTask = z.object({ task: taskSchema }).loose().parse(await receiver.rpc('developmentTasks/create', { request: {
        origin: { kind: 'root' }, objective: study.roles[role].goal, scope: 'Existing local payment responsibility.', createdBy: before.participantId } }))
      await receiver.rpc('developmentTaskAssignments/checkout', { request: { taskId: localTask.task.id,
        participantId: before.participantId, sessionLabel: role === 'B' ? 'Payment client policy' : 'Payment QA cases' } })
      await receiver.native('start')
      const observation = observedSession.parse(await receiver.native('finish'))
      await persistSession(request.output, 'initial', role, host(role), observation)
      completed(observation)
      if (observation.requests.length === 0 || server.blocked()) throw new Error('initial work lacks settled model accounting')
      for (const item of observation.requests) {
        if (sources(item.messages).length !== 0) throw new Error('initial work received shared context')
        const evidence = observeMixedRequest(item.messages)
        if (evidence.managedBytes > 8000 || evidence.localBytes === 0 || evidence.visibleVerification !== null) throw new Error('initial local context differs')
      }
      const status = statusSchema.parse(await receiver.native('status'))
      if (status.local.assignment?.taskId !== localTask.task.id || status.local.capture !== null) throw new Error('initial local responsibility missing')
      initial.set(role, { status, observation, target: recipients[role] })
      await save(request.output, `initial-${role}-state.json`, status)
    }
    await owner.rpc('developmentRooms/announce', { request: { id: 'mixed-owner', kind: 'human', displayName: 'Shared goal owner' } })
    const created = z.object({ task: taskSchema }).loose().parse(await owner.rpc('developmentTasks/create', { request: {
      origin: { kind: 'root' }, objective: 'Maintain payment client policy and independent QA cases.',
      scope: 'Authorized policy, verification and documentation work.', createdBy: 'mixed-owner' } }))
    for (const role of ['A', 'D'] as const) {
      const source = connection(role)
      const entry = z.object({ entry: z.object({ entryId: z.string() }).loose() }).loose().parse(
        await owner.rpc('scopeAccess/createContributionEntry', { request: { taskId: created.task.id, sourceKind: 'tool-observations',
          ownerAddress: address, expiresAt: Date.now() + study.limits.wallTimeoutMs } }))
      const sourceId = z.object({ agentId: z.string() }).loose().parse(await source.native('status')).agentId
      const limits = { expiresAt: Date.now() + study.limits.wallTimeoutMs, maxSamples: 4, maxSampleBytes: 16384 }
      const requested = captureSchema.parse(await source.rpc('scopeAgentContributions/request', { request: {
        agentId: sourceId, expectedCapture: null, entry: entry.entry, roots: [sourceProjects[role]], tools: role === 'A' ? ['write', 'edit'] : ['write'],
        ...role === 'A' ? { commands: [{ command: study.source.command, rootIndex: 0 }] } : {}, limits } }))
      if (requested.capture === null) throw new Error('source consent missing')
      await until(() => owner.rpc('scopeAccess/contributionApplications', { request: { taskId: created.task.id } }),
        value => JSON.stringify(value).includes('"status":"pending"'), lifetime.signal)
      await owner.rpc('scopeAccess/approveContributionApplication', { request: { entryId: entry.entry.entryId,
        expectedProposal: requested.capture.proposal, limits, ownerAddress: address } })
      await until(async () => captureSchema.parse(await source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } })),
        value => value.capture?.collecting === true, lifetime.signal)
      await source.native('start')
      const observation = observedSession.parse(await source.native('finish'))
      sourceControlled += observation.requests.length
      completed(observation)
      await persistSession(request.output, 'source', role, host(role), observation)
      await until(async () => taskSchema.parse(await owner.rpc('developmentTasks/get', { request: { taskId: created.task.id } })),
        value => value.context.length === (role === 'A' ? 4 : 8), lifetime.signal)
      await until(async () => captureSchema.parse(await source.rpc('scopeAgentContributions/status', { request: { agentId: sourceId } })),
        value => value.capture?.pendingSamples === 0, lifetime.signal)
      const rows = sqliteRows(join(host(role).directory, 'state.sqlite'), 'u_scope_agent_contributions_sessions')
      const events = sqliteRows(join(host('O').directory, 'state.sqlite'), 'u_development_context_tasks_events')
      verifyReceipts(observation, rows, events, source.identity.peerId, owner.identity.peerId, 4)
      const replicas = z.array(taskSchema).parse(await source.rpc('developmentTasks/list', { request: { limit: 1 } }))
      if (replicas.length !== 0) throw new Error('source received a shared Task replica')
      await save(request.output, `source-${role}-receipts.json`, { rows, events, sourceTaskReplicas: replicas.length })
    }
    if (await readFile(join(sourceProjects.A, study.source.path), 'utf8') !== study.source.expectedContent) throw new Error('actual source policy differs')
    for (const document of study.source.documents) {
      if (await readFile(join(sourceProjects.D, document.path), 'utf8') !== (document.path === overwrite.path ? replaced : document.content)) {
        throw new Error('actual source documentation differs')
      }
    }
    const task = taskSchema.parse(await owner.rpc('developmentTasks/get', { request: { taskId: created.task.id } }))
    const reports = task.context.map(value => z.object({ peerToolObservation: z.object({ kind: z.string() }).loose() })
      .loose().parse(value).peerToolObservation)
    const commands = reports.filter(value => value.kind === 'command-observation').map(value => z.object({
      fields: z.object({ command: z.literal(study.source.command), rootIndex: z.literal(0) }), state: z.literal('completed'),
      exitCode: z.number(), signal: z.null(), aborted: z.literal(false), timedOut: z.literal(false),
    }).loose().parse(value))
    if (!isDeepStrictEqual(commands.map(value => value.exitCode), [0, 7])) throw new Error('actual source command trajectory differs')
    ownerRevision = task.revision
    server.setWatermark({ taskId: task.id, revision: task.revision, condition: request.condition })
    await save(request.output, 'source-admission.json', { task, reports, commands, ownerRevision })
    for (const role of ['B', 'C'] as const) {
      if (server.blocked()) throw new Error('model accounting blocks the next recipient')
      const receiver = connection(role); const original = initial.get(role)
      if (original === undefined || original.status.local.assignment === null) throw new Error('original recipient missing')
      const assignment = original.status.local.assignment
      if (request.condition !== 'N') {
        const invitation = await owner.rpc('scopeAccess/invite', { request: { taskId: task.id, ownerAddress: address,
          recipientPeerId: receiver.identity.peerId, expiresAt: Date.now() + study.limits.wallTimeoutMs,
          responsibility: role === 'B' ? 'Maintain the payment client policy and preserve complete request bodies.'
            : 'Maintain payment QA cases for retry boundaries, non-retry errors, and observed verification failures.' } })
        await receiver.rpc('scopeAgentContext/bind', { request: { agentId: original.status.agentId, expectedBindingId: null, invitation,
          automatic: null, localTask: { taskId: assignment.taskId, taskBindingId: assignment.bindingId,
            expectedBindingEpoch: assignment.expectedBindingEpoch } } })
      }
      await receiver.native('continue')
      const observation = observedSession.parse(await receiver.native('finish'))
      await persistSession(request.output, 'mixed', role, host(role), observation)
      completed(observation)
      if (server.blocked()) throw new Error('mixed work lacks settled model accounting')
      const mixed = statusSchema.parse(await receiver.native('status'))
      const fresh = observation.requests.slice(original.observation.requests.length)
      if (fresh.length === 0 || observation.agentId !== original.observation.agentId
        || observation.sessionId !== original.observation.sessionId
        || !isDeepStrictEqual(observation.events.slice(0, original.observation.events.length), original.observation.events)
        || !isDeepStrictEqual(observation.requests.slice(0, original.observation.requests.length), original.observation.requests)
        || !isDeepStrictEqual(mixed.local.assignment, assignment) || mixed.local.capture !== null || mixed.scopeState.automatic !== null) {
        throw new Error('mixed context replaced original local work or permission')
      }
      const evidence = observation.requests.map(item => observeMixedRequest(item.messages))
      if (evidence.some(item => item.managedBytes > 8000 || item.localBytes === 0)
        || observation.requests.some(item => !isDeepStrictEqual(item.tools, original.observation.requests[0]?.tools))) {
        throw new Error('mixed context allowance or original tools changed')
      }
      for (const item of fresh) {
        const snapshots = sources(item.messages)
        if (request.condition === 'N' ? snapshots.length !== 0 : snapshots.length !== 1
          || snapshots[0]?.taskRevision !== task.revision || snapshots[0].backend.id !== (request.condition === 'semantic' ? 'semantic' : 'reported-files')) {
          throw new Error('mixed request lacks its frozen source watermark and backend')
        }
      }
      const target = original.target
      const artifact = await sealedFile(target, target.spec.artifactPath, lifetime.signal)
      if (role === 'B') artifacts.policy = artifact; else artifacts.cases = artifact
      artifacts.verification[role] = await sealedFile(target, study.verificationPath, lifetime.signal)
      artifacts.visibleVerification[role] = evidence.at(-1)?.visibleVerification ?? null
      await save(request.output, `mixed-${role}-request-evidence.json`, evidence)
      if (request.condition !== 'N') {
        if (mixed.scopeState.binding === null) throw new Error('shared binding missing before departure')
        await receiver.rpc('scopeAgentContext/leave', { request: { agentId: mixed.agentId, expectedBindingId: mixed.scopeState.binding.id } })
      }
      const left = statusSchema.parse(await receiver.native('status'))
      const retained = request.condition === 'N' ? null : z.object({ kind: z.literal('local-task-scope'),
        target: z.object({ taskId: z.literal(assignment.taskId), taskBindingId: z.literal(assignment.bindingId),
          bindingEpoch: z.object({ nodeId: z.literal(assignment.expectedBindingEpoch.nodeId),
            seq: z.literal(assignment.expectedBindingEpoch.seq) }), participantId: z.literal(original.status.participantId) }),
        retainedLocal: z.object({ bindingId: z.string(), automatic: z.null() }),
      }).parse(mixed.scopeState.binding)
      const expectedBinding = retained === null ? original.status.scopeState.binding
        : { kind: 'local-task', id: retained.retainedLocal.bindingId, target: retained.target }
      if (left.requests !== observation.requests.length || !isDeepStrictEqual(left.local.assignment, assignment)
        || left.local.capture !== null || !isDeepStrictEqual(left.scopeState.binding, expectedBinding)
        || left.scopeState.automatic !== null) throw new Error('departure changed local work or dispatched a model')
      const departed = observedSession.parse(await receiver.native('finish'))
      await persistSession(request.output, 'left', role, host(role), departed)
      const phases = { initial: original.status, mixed, left }
      await save(request.output, `recipient-${role}-states.json`, phases)
      roles[role] = { agentId: observation.agentId, sessionId: observation.sessionId, localTaskId: assignment.taskId,
        requests: observation.requests.length, initialRequests: original.observation.requests.length, mixedRequests: fresh.length,
        identityPreserved: true, completed: true, turnReason: observation.turnReason,
        maxManagedBytes: Math.max(...evidence.map(item => item.managedBytes)), durable: departed.durable, phases }
    }
    if (request.condition === 'semantic') await persistSession(request.output, 'semantic', 'O', host('O'), await owner.native('finish'))
    await save(request.output, 'sealed-artifacts.json', artifacts)
    grade = request.grade === undefined ? null : await request.grade(artifacts)
    lifetime.signal.throwIfAborted()
  } catch (error) {
    failure = error
    const collectionSignal = AbortSignal.timeout(study.limits.cleanupTimeoutMs)
    const collectionErrors: { role: string; operation: string; error: string }[] = []
    for (const [role, owned] of hosts) {
      if (role === 'O' && request.condition !== 'semantic') continue
      let observer: Connection
      try { observer = await owned.connect(collectionSignal) }
      catch (error) { collectionErrors.push({ role, operation: 'connect', error: errorText(error) }); continue }
      if (role !== 'O') {
        try { await observer.native('cancel') }
        catch (error) { collectionErrors.push({ role, operation: 'cancel', error: errorText(error) }) }
      }
      try {
        const partial = await observer.native('finish')
        await persistSession(request.output, 'partial', role, owned, partial)
      } catch (error) { collectionErrors.push({ role, operation: 'finish-and-persist', error: errorText(error) }) }
    }
    await save(request.output, 'partial-collection-errors.json', collectionErrors)
    if (recipients !== undefined) {
      const collection = AbortSignal.timeout(study.limits.cleanupTimeoutMs)
      for (const role of ['B', 'C'] as const) {
        const target = recipients[role]
        try {
          const artifact = await sealedFile(target, target.spec.artifactPath, collection)
          if (role === 'B') artifacts.policy = artifact; else artifacts.cases = artifact
          artifacts.verification[role] = await sealedFile(target, study.verificationPath, collection)
        } catch (error) { await save(request.output, `partial-${role}-artifact-error.json`, { error: errorText(error) }) }
      }
      await save(request.output, 'partial-sealed-artifacts.json', artifacts)
    }
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', cancelled)
    lifetime.abort(new Error('native mixed run complete'))
    if (server !== undefined) await server.close().catch((error: unknown) => { failure ??= error })
    for (const [role, host] of [...hosts].reverse()) {
      try {
        const ended = await host.stop(); cleanup.closed++; if (ended.signal === 'SIGKILL') cleanup.forced++
        await save(request.output, `${role}-exit.json`, { code: ended.code, signal: ended.signal,
          stdoutBytes: Buffer.byteLength(ended.stdout), stderrBytes: Buffer.byteLength(ended.stderr),
          ...request.execution.kind === 'transport-calibration' && failure !== undefined
            ? { stdout: ended.stdout, stderr: ended.stderr } : {} })
        try { await cp(join(host.directory, 'sessions'), join(request.output, `final-${role}-durable-sessions`), { recursive: true }) }
        catch (error) {
          // Owners without a summary reservation have no durable audit Session to copy.
          const ownerWithoutAudit = role === 'O' && !server?.reservations.some(item => item.role === 'O')
          if (!(ownerWithoutAudit && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      } catch (error) { failure ??= error }
    }
    await rm(temporary, { recursive: true, force: true })
  }
  if (cleanup.closed !== cleanup.started || cleanup.forced > 0) failure ??= new Error('mixed Host cleanup did not settle normally')
  const reservations = server?.reservations ?? []
  const counts = { ordinary: reservations.filter(item => item.role !== 'O').length,
    semantic: reservations.filter(item => item.role === 'O').length, sourceControlled }
  const result: NativeMixedRunResult = { kind: 'native-mixed-run', condition: request.condition, execution: request.execution,
    failed: failure !== undefined || Object.keys(roles).length !== 2, error: failure === undefined ? null : errorText(failure),
    dispatchBlocked: server?.blocked() ?? false, realModelDispatches: request.execution.kind === 'live' ? counts.ordinary + counts.semantic : 0,
    counts, modelCounterMeaning: 'Persisted permission to delegate to the production HTTP adapter; not proof of HTTP-send, billing, or useful model output.',
    topology: { hosts: 5, responsibilityAgents: 4, transport: 'tcp-noise', physicalDevices: 1 }, ownerRevision, peers, roles, artifacts, grade, cleanup }
  await save(request.output, 'dispatch-ledger.json', reservations)
  await save(request.output, 'result.json', result)
  return result
}
