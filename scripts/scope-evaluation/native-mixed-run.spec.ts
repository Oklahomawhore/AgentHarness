/** Named-profile mixed-work calibration uses controlled HTTP replies, never real model-quality evidence. */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { scanLog } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createMixedStudy, gradeMixedArtifacts, mixedStudyConditions, parseMixedVerification } from './mixed-study.ts'
import { parsePolicy, sealDataArtifact } from './data-artifacts.ts'
import { createMixedHttpResponder, openMixedHttpFixture } from './mixed-http-fixture.ts'
import { runNativeMixed } from './native-mixed-run.ts'
import { prepareDataStudy, runDataPhase } from './data-cli.ts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const enabled = process.env.DSH_NATIVE_DATA_EVALUATION === '1' && process.platform !== 'win32'
const continuation = 'Continue your existing local responsibility using currently available authorized context. '
  + 'Update your assigned artifacts and verification report when warranted.'

function studyAt(endpoint: string) {
  const route = { provider: 'deepseek-official' as const,
    endpointSource: { kind: 'openai-compatible-gateway' as const, name: 'local-http-calibration' }, network: { kind: 'direct' as const },
    model: 'controlled-http-replies', endpoint, apiKeyEnv: 'DSH_DATA_CALIBRATION_KEY', credentialsPath: null,
    maxCalls: 4, maxInputBytes: 131072, maxOutputTokens: 4096, maxOutputBytes: 65536, timeoutMs: 15000 }
  return createMixedStudy(20261004, { ordinary: route, semantic: { ...route, maxCalls: 2, maxInputBytes: 65536, maxOutputTokens: 2048 },
    limits: { contextBytes: 8000, maxArtifactBytes: 65536, wallTimeoutMs: 90000, cleanupTimeoutMs: 10000, operationTimeoutMs: 20000 } })
}

it('derives controlled outputs from HTTP text and cannot recover a correction from hidden message metadata', () => {
  const study = studyAt('http://127.0.0.1:1')
  const responder = createMixedHttpResponder(study.runtime.roles)
  const report = '<shared-work-updates>\n' + JSON.stringify({ updates: [{ sources: [{ quote: 'maxRetries: 1' }] }],
    mandatory: [{ kind: 'command-evidence', publication: { localToolObservation: { kind: 'command-observation', version: 4,
      fields: { command: 'node verify.cjs', rootIndex: 0 }, state: 'completed', exitCode: 7,
      signal: null, timedOut: false, aborted: false } } }] }) + '\n</shared-work-updates>'
  for (const visible of [true, false]) {
    const reply = responder({ model: 'controlled-http-replies', messages: [
      { role: 'user', content: study.runtime.roles.B.goal },
      { role: 'assistant', content: 'Earlier local work completed.' },
      { role: 'user', content: continuation },
      { role: 'user', content: visible ? report : 'No shared report is available.', source: { projection: { text: report } } },
    ] })
    expect(reply.finish).toBe('tool_calls')
    const writes = z.object({ tool_calls: z.array(z.object({ function: z.object({ name: z.literal('evaluation_write'), arguments: z.string() }) })) })
      .parse(reply.delta).tool_calls.map(call => z.object({ path: z.string(), text: z.string() })
        .parse(JSON.parse(call.function.arguments) as unknown))
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[0]?.text ?? '')).toMatchObject({ maxRetries: visible ? 1 : 3 })
    expect(JSON.parse(writes[1]?.text ?? '')).toEqual(visible
      ? { version: 1, status: 'failed', exitCode: 7 } : { version: 1, status: 'unavailable', exitCode: null })
  }
})

it('keeps compact HTTP summary quotes in their actual source bodies without changing the public baseline', () => {
  const study = studyAt('http://127.0.0.1:1')
  const responder = createMixedHttpResponder(study.runtime.roles)
  const sources = [
    { sourceId: 'a'.repeat(64), body: study.runtime.source.initialContent, attribution: { path: 'policy.md', tool: 'Write' } },
    { sourceId: 'b'.repeat(64), body: JSON.stringify(study.runtime.source.correction), attribution: { path: 'policy.md', tool: 'Edit' } },
    { sourceId: 'c'.repeat(64), body: 'Documentation example: maxRetries: 9', attribution: { path: 'guide.md', tool: 'Write' } },
  ]
  const reply = responder({ model: 'controlled-http-replies', messages: [
    { role: 'system', content: 'Summarize the supplied authorized work reports' },
    { role: 'user', content: JSON.stringify({ sources }) },
  ] })
  expect(reply.kind).toBe('semantic')
  const parsed = z.object({ version: z.literal(1), decisions: z.array(z.object({ sourceId: z.string(), relevant: z.boolean() })),
    updates: z.array(z.object({ text: z.string(), sources: z.array(z.object({ sourceId: z.string(), quote: z.string() })) })) })
    .parse(JSON.parse(z.string().parse(reply.delta.content)) as unknown)
  expect(parsed.decisions.map(decision => decision.relevant)).toEqual([true, true, false])
  expect(parsed.updates).toHaveLength(1)
  const citations = parsed.updates.flatMap(update => update.sources)
  expect(citations.map(citation => citation.quote)).toEqual(['maxRetries: 3', 'maxRetries: 1'])
  for (const citation of citations) expect(sources.find(source => source.sourceId === citation.sourceId)?.body).toContain(citation.quote)
  expect(study.runtime.roles.B.initialFiles['public/payment-policy.json']).toContain('"maxRetries": 3')
})

const sealed = z.object({ text: z.string(), bytes: z.number(), sha256: z.string() })
const runSchema = z.object({ condition: z.enum(mixedStudyConditions), failed: z.boolean(), error: z.string().nullable(),
  dispatchBlocked: z.boolean(), realModelDispatches: z.number(),
  counts: z.object({ ordinary: z.number(), semantic: z.number(), sourceControlled: z.number() }),
  peers: z.array(z.string()), cleanup: z.object({ started: z.number(), closed: z.number(), forced: z.number() }),
  roles: z.object({ B: z.unknown(), C: z.unknown() }), grade: z.unknown(),
  artifacts: z.object({ policy: sealed.nullable(), cases: sealed.nullable(),
    verification: z.object({ B: sealed.nullable(), C: sealed.nullable() }) }),
})
const sessionSchema = z.object({ agentId: z.string(), sessionId: z.string(), events: z.array(z.unknown()),
  requests: z.array(z.object({ messages: z.array(z.unknown()), tools: z.array(z.unknown()), eventCount: z.number() }).loose()),
  durable: z.object({ sha256: z.string(), bytes: z.number(), eventCount: z.number(),
    requestReconstruction: z.literal(true), file: z.string() }),
})
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown }
async function checkSession(output: string, phase: string, role: string) {
  const session = sessionSchema.parse(await readJson(join(output, `${phase}-${role}-session.json`)))
  const bytes = await readFile(join(output, `${phase}-${role}-durable-sessions`, session.durable.file))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(session.durable.sha256)
  expect(bytes.length).toBe(session.durable.bytes)
  const stored = scanLog(bytes)
  expect(stored.committedBytes).toBe(bytes.length)
  expect(stored.events).toEqual(session.events)
  for (const request of session.requests) {
    const detached = Session.create(SessionId(session.sessionId), stored.events.slice(0, request.eventCount), stored.meta)
    expect(detached.deriveMessages()).toEqual(request.messages)
  }
  for (const event of stored.events) {
    if (event.type !== 'tool/result') continue
    expect(event.data.error).toBeUndefined()
    expect(event.data.message.content.some(block => block.type === 'tool-result' && block.isError === true)).toBe(false)
  }
  return session
}
async function checkSource(output: string) {
  const source = z.object({ commands: z.array(z.object({ state: z.literal('completed'), exitCode: z.number(),
    signal: z.null(), aborted: z.literal(false), timedOut: z.literal(false) }).loose()), reports: z.array(z.unknown()) })
    .parse(await readJson(join(output, 'source-admission.json')))
  expect(source.commands.map(command => command.exitCode)).toEqual([0, 7])
  expect(source.reports).toHaveLength(8)
  for (const role of ['A', 'D']) {
    expect(await readJson(join(output, `source-${role}-receipts.json`))).toMatchObject({ sourceTaskReplicas: 0 })
    await checkSession(output, 'source', role)
  }
}
async function checkControlRun(value: unknown, output: string) {
  const result = runSchema.parse(value)
  const condition = z.enum(['N', 'reported']).parse(result.condition)
  expect(result.failed, result.error ?? '').toBe(false)
  expect(result.cleanup).toEqual({ started: 5, closed: 5, forced: 0 })
  expect(result.realModelDispatches).toBe(0)
  expect(new Set(result.peers).size).toBe(5)
  expect(result.dispatchBlocked).toBe(false)
  expect(result.counts).toEqual({ ordinary: 8, semantic: 0, sourceControlled: 16 })
  await checkSource(output)
  for (const role of ['B', 'C'] as const) {
    expect(result.roles[role]).toMatchObject({ requests: 4, initialRequests: 2, mixedRequests: 2, identityPreserved: true })
    const initial = await checkSession(output, 'initial', role)
    const mixed = await checkSession(output, 'mixed', role)
    const left = await checkSession(output, 'left', role)
    expect(initial.requests).toHaveLength(2)
    expect(mixed.requests).toHaveLength(4)
    expect(mixed.events.slice(0, initial.events.length)).toEqual(initial.events)
    expect(mixed.requests.slice(0, initial.requests.length)).toEqual(initial.requests)
    expect(left.requests).toEqual(mixed.requests)
    expect([mixed.agentId, left.agentId]).toEqual([initial.agentId, initial.agentId])
    expect([mixed.sessionId, left.sessionId]).toEqual([initial.sessionId, initial.sessionId])
    expect(mixed.requests.every(request => JSON.stringify(request.tools) === JSON.stringify(initial.requests[0]?.tools))).toBe(true)
    const state = z.object({ participantId: z.string(), local: z.object({ assignment: z.unknown(), capture: z.null() }),
      scopeState: z.object({ binding: z.unknown(), automatic: z.null(), mode: z.string() }) })
    const phases = z.object({ initial: state, mixed: state, left: state })
      .parse(await readJson(join(output, `recipient-${role}-states.json`)))
    expect(phases.initial.local.assignment).not.toBeNull()
    expect(phases.mixed.local.assignment).toEqual(phases.initial.local.assignment)
    expect(phases.left.local.assignment).toEqual(phases.initial.local.assignment)
    expect(phases.initial.scopeState.binding).toBeNull()
    if (condition === 'N') expect(phases.left.scopeState.binding).toBeNull()
    else {
      const assignment = z.object({ taskId: z.string(), bindingId: z.string(),
        expectedBindingEpoch: z.object({ nodeId: z.string(), seq: z.number() }) })
        .parse(phases.initial.local.assignment)
      const mixedBinding = z.object({ kind: z.literal('local-task-scope'), target: z.unknown(),
        retainedLocal: z.object({ bindingId: z.string(), automatic: z.null() }) }).parse(phases.mixed.scopeState.binding)
      expect(mixedBinding.target).toEqual({ taskId: assignment.taskId, taskBindingId: assignment.bindingId,
        bindingEpoch: assignment.expectedBindingEpoch, participantId: phases.initial.participantId })
      expect(phases.left.scopeState.binding).toEqual({ kind: 'local-task', id: mixedBinding.retainedLocal.bindingId,
        target: mixedBinding.target })
      expect(phases.left.scopeState.automatic).toEqual(mixedBinding.retainedLocal.automatic)
      expect(phases.left.scopeState.mode).toBe('passive')
    }
    const evidence = z.array(z.object({ localBytes: z.number(), sharedBytes: z.number(), managedBytes: z.number(),
      visibleVerification: z.number().nullable() })).parse(await readJson(join(output, `mixed-${role}-request-evidence.json`)))
    expect(evidence).toHaveLength(4)
    for (const item of evidence) {
      expect(item.localBytes).toBeGreaterThan(0)
      expect(item.managedBytes).toBe(item.localBytes + item.sharedBytes)
      expect(item.managedBytes).toBeLessThanOrEqual(8000)
    }
    expect(evidence.slice(0, 2).map(item => item.sharedBytes)).toEqual([0, 0])
    expect(evidence.slice(2).map(item => item.visibleVerification)).toEqual([null, null])
    const verification = result.artifacts.verification[role]
    if (verification === null) throw new Error('verification artifact absent')
    expect(parseMixedVerification(verification)).toEqual({ version: 1, status: 'unavailable', exitCode: null })
  }
  const policy = result.artifacts.policy
  if (policy === null) throw new Error('policy artifact absent')
  expect(parsePolicy(policy).maxRetries).toBe(3)
  expect(result.grade).toMatchObject({ pairStatus: 'failed', verification: { B: { status: 'passed' }, C: { status: 'passed' } },
    currentEvidenceAvailable: { B: false, C: false } })
}

async function checkPartial(output: string, artifacts: unknown, expectedRequests = { B: 3, C: 2 }) {
  expect(await readJson(join(output, 'partial-sealed-artifacts.json'))).toEqual(artifacts)
  const files = z.object({ policy: sealed, cases: sealed, verification: z.object({ B: sealed, C: sealed }) }).parse(artifacts)
  for (const file of [files.policy, files.cases, files.verification.B, files.verification.C]) {
    expect(sealDataArtifact(file.text)).toEqual(file)
  }
  for (const role of ['B', 'C'] as const) {
    const partial = await checkSession(output, 'partial', role)
    expect(partial.requests).toHaveLength(expectedRequests[role])
    const bytes = await readFile(join(output, `final-${role}-durable-sessions`, partial.durable.file))
    const stored = scanLog(bytes)
    expect(stored.committedBytes).toBe(bytes.length)
    expect(stored.events.slice(0, partial.events.length)).toEqual(partial.events)
  }
}

async function retainAndRemove(root: string) {
  try {
    const evidence = process.env.DSH_MIXED_NATIVE_EVIDENCE_ROOT
    if (evidence !== undefined) {
      await mkdir(evidence, { recursive: true, mode: 0o700 })
      await cp(root, join(evidence, basename(root)), { recursive: true, errorOnExist: true, force: false })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}

// This characterizes the current capacity gap; product acceptance still requires successful shared evidence and artifacts.
// The opt-in lane uses real POSIX Bash tools and five independently allocated named dsh Hosts per condition.
it.skipIf(!enabled)('records semantic capacity failure after completing both control conditions through frozen CLI phases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-mixed-cli-spec-'))
  let http: Awaited<ReturnType<typeof openMixedHttpFixture>> | undefined
  try {
    http = await openMixedHttpFixture()
    const study = studyAt(http.endpoint)
    http.configure(study.runtime.roles)
    const directory = join(root, 'registered')
    const config = { ordinary: study.runtime.ordinary, semantic: study.runtime.semantic, limits: study.runtime.limits }
    await prepareDataStudy({ root: directory, seed: study.runtime.seed, execution: 'transport-calibration', config, protocol: 'mixed' })
    expect(await runDataPhase('preflight', directory)).toMatchObject({ failed: false, hostsStarted: 0, modelDispatches: 0, maximumDispatches: 26 })
    expect(http.calls).toHaveLength(0)
    const result = await runDataPhase('execute', directory)
    await writeFile(join(root, 'http-observations.json'), JSON.stringify({ calls: http.calls, errors: http.errors }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    expect(http.errors).toEqual([])
    expect(result).toMatchObject({ failed: true, completedConditions: 3, skippedConditions: [] })
    const runs = z.array(z.unknown()).parse(result['results'])
    expect(runs).toHaveLength(3)
    const controls = runs.slice(0, 2).map(run => runSchema.parse(run))
    expect(controls.map(run => run.condition)).toEqual(['N', 'reported'])
    for (const run of controls) await checkControlRun(run, join(directory, 'execute', run.condition))
    const capacity = z.object({ condition: z.literal('semantic'), failed: z.literal(true), grade: z.null(),
      error: z.literal('ordinary turn did not complete'), dispatchBlocked: z.literal(false), realModelDispatches: z.literal(0),
      roles: z.strictObject({}),
      counts: z.object({ ordinary: z.literal(4), semantic: z.literal(1), sourceControlled: z.literal(16) }),
      artifacts: z.strictObject({ policy: sealed, cases: sealed, verification: z.object({ B: sealed, C: sealed }),
        visibleVerification: z.object({ B: z.null(), C: z.null() }) }),
      cleanup: z.object({ started: z.literal(5), closed: z.literal(5), forced: z.literal(0) }) }).parse(runs[2])
    expect(http.calls).toHaveLength(21)
    expect(controls.reduce((sum, run) => sum + run.counts.ordinary + run.counts.semantic, 0)
      + capacity.counts.ordinary + capacity.counts.semantic).toBe(21)
    const ordinary = http.calls.filter(call => call.kind !== 'semantic')
    for (let start = 0; start < 16; start += 8) {
      const group = ordinary.slice(start, start + 8)
      expect(group.map(call => call.kind)).toEqual(['B-initial', 'B-initial', 'C-initial', 'C-initial', 'B-mixed', 'B-mixed', 'C-mixed', 'C-mixed'])
      expect(group.slice(0, 4).every(call => !JSON.stringify(call.body.messages).includes('maxRetries: 1'))).toBe(true)
    }
    expect(http.calls.slice(16).map(call => call.kind)).toEqual(['B-initial', 'B-initial', 'C-initial', 'C-initial', 'semantic'])
    const output = join(directory, 'execute', 'semantic')
    await checkSource(output)
    await checkPartial(output, capacity.artifacts, { B: 3, C: 2 })
    for (const role of ['B', 'C'] as const) {
      const initial = await checkSession(output, 'initial', role)
      const partial = await checkSession(output, 'partial', role)
      expect(initial.requests).toHaveLength(2)
      expect(partial.requests.slice(0, initial.requests.length)).toEqual(initial.requests)
      if (role === 'C') expect(partial.requests).toEqual(initial.requests)
      else {
        const prepared = z.object({ index: z.literal(2), sourceSeqs: z.array(z.number()), reconstructed: z.literal(true),
          eventCount: z.number(), messages: z.array(z.object({ source: z.object({ kind: z.string() }).loose().optional() }).loose()),
          tools: z.array(z.unknown()) }).parse(partial.requests[2])
        const shared = prepared.messages.filter(message => message.source?.kind === 'scope-agent-context')
        expect(shared.map(message => message.source)).toEqual([
          { kind: 'scope-agent-context', version: 1, form: 'withdrawn', reason: 'unavailable' },
        ])
        expect(prepared.tools).toEqual(initial.requests[0]?.tools)
        const events = z.array(z.object({ type: z.string(), seq: z.number(), data: z.unknown() })).parse(partial.events)
        const withdrawn = events.filter(event => prepared.sourceSeqs.includes(event.seq))
        expect(withdrawn).toHaveLength(1)
        expect(withdrawn[0]?.type).toBe('user/message')
        expect(withdrawn[0]?.data).toEqual(shared[0])
        const rejected = events.slice(prepared.eventCount)
        expect(rejected.map(event => event.type)).toEqual(['assistant/attempt', 'step/end', 'turn/end'])
        expect(rejected[0]?.data).toEqual({ turn: 2, step: 1, stream: [] })
        const reason = { kind: 'error', error: { message: 'parent model accounting rejected the operation', code: 'UNKNOWN' } }
        expect(rejected[2]?.data).toEqual({ turn: 2, reason })
        const accounting = z.object({ turnReason: z.unknown(), modelUsage: z.object({ dispatchAttempts: z.literal(2),
          unknownUsage: z.literal(false), calls: z.array(z.object({ reservation: z.string(),
            usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }), responseObserved: z.literal(true) })) }) })
          .parse(await readJson(join(output, 'partial-B-session.json')))
        expect(accounting.turnReason).toEqual(reason)
        expect(accounting.modelUsage.calls).toHaveLength(2)
      }
      expect(partial.events.slice(0, initial.events.length)).toEqual(initial.events)
      expect(partial.agentId).toBe(initial.agentId)
      expect(partial.sessionId).toBe(initial.sessionId)
      expect(capacity.artifacts.verification[role].text).toBe(study.runtime.roles[role].initialFiles['verification.json'])
    }
    expect(capacity.artifacts.policy.text).toBe(study.runtime.roles.B.initialFiles[study.runtime.roles.B.artifactPath])
    expect(capacity.artifacts.cases.text).toBe(study.runtime.roles.C.initialFiles[study.runtime.roles.C.artifactPath])
    const audit = z.object({ events: z.array(z.object({ type: z.string(), seq: z.number(), data: z.unknown() }).loose()) })
      .parse(await readJson(join(output, 'partial-O-session.json')))
    const requests = audit.events.filter(event => event.type === 'context/semantic-request')
    const results = audit.events.filter(event => event.type === 'context/semantic-result')
    expect(requests).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(z.object({ maxContextBytes: z.number() }).parse(requests[0]?.data).maxContextBytes).toBe(6681)
    const summaryResult = z.object({ status: z.literal('failed'), projection: z.null(), requestSeq: z.number(),
      error: z.literal('semantic output: relevant updates and mandatory evidence exceed maxContextBytes'),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }), finish: z.object({ kind: z.literal('stop') }) })
      .parse(results[0]?.data)
    expect(summaryResult.requestSeq).toBe(requests[0]?.seq)
    const auditFiles = (await readdir(join(output, 'final-O-durable-sessions'), { recursive: true }))
      .filter(file => file.endsWith('.jsonl'))
    expect(auditFiles).toHaveLength(1)
    const auditFile = auditFiles[0]
    if (auditFile === undefined) throw new Error('final semantic audit file absent')
    const auditBytes = await readFile(join(output, 'final-O-durable-sessions', auditFile))
    const storedAudit = scanLog(auditBytes)
    expect(storedAudit.committedBytes).toBe(auditBytes.length)
    expect(storedAudit.events).toEqual(audit.events)
    const reservations = z.array(z.object({ role: z.enum(['B', 'C', 'O']), result: z.object({
      operation: z.literal('model-settle'), usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
      responseObserved: z.literal(true),
    }) })).parse(await readJson(join(output, 'dispatch-ledger.json')))
    expect(reservations.map(item => item.role)).toEqual(['B', 'B', 'C', 'C', 'O'])
    await expect(runDataPhase('execute', directory)).rejects.toThrow()
    expect(http.calls).toHaveLength(21)
  } finally {
    try { await http?.close() } finally { await retainAndRemove(root) }
  }
}, 300000)

for (const fault of ['missing-mixed-usage', 'cancel-mixed'] as const) {
  it.skipIf(!enabled)(`blocks later dispatch after ${fault} in an already working Session`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-mixed-fault-spec-'))
    const cancellation = new AbortController()
    let http: Awaited<ReturnType<typeof openMixedHttpFixture>> | undefined
    try {
      http = await openMixedHttpFixture({ omitMixedUsage: fault === 'missing-mixed-usage',
        ...fault === 'cancel-mixed' ? { cancelMixed: cancellation } : {} })
      const study = studyAt(http.endpoint)
      http.configure(study.runtime.roles)
      const output = join(root, 'run')
      const result = await runNativeMixed({ repo, nodePath: process.execPath, output, condition: 'reported', study: study.runtime,
        execution: { kind: 'transport-calibration' }, signal: cancellation.signal,
        grade: artifacts => gradeMixedArtifacts({ condition: 'reported', ...artifacts, oracle: study.oracle }) })
      await writeFile(join(root, 'http-observations.json'), JSON.stringify({ calls: http.calls, errors: http.errors }, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 })
      expect(http.errors).toEqual([])
      expect(result.failed, result.error ?? '').toBe(true)
      expect(result.cleanup).toEqual({ started: 5, closed: 5, forced: 0 })
      expect(result.realModelDispatches).toBe(0)
      expect(result.dispatchBlocked).toBe(true)
      expect(result.counts).toEqual({ ordinary: 5, semantic: 0, sourceControlled: 16 })
      expect(http.calls.map(call => call.kind)).toEqual(['B-initial', 'B-initial', 'C-initial', 'C-initial', 'B-mixed'])
      await checkSource(output)
      await checkPartial(output, result.artifacts)
    } finally {
      try { await http?.close() } finally { await retainAndRemove(root) }
    }
  }, 120000)
}

it.skipIf(!enabled)('keeps the per-Session call limit across initial and mixed work and skips subsequent frozen conditions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-mixed-budget-spec-'))
  let http: Awaited<ReturnType<typeof openMixedHttpFixture>> | undefined
  try {
    http = await openMixedHttpFixture()
    const study = studyAt(http.endpoint)
    http.configure(study.runtime.roles)
    const directory = join(root, 'registered')
    await prepareDataStudy({ root: directory, seed: study.runtime.seed, execution: 'transport-calibration', protocol: 'mixed',
      config: { ordinary: { ...study.runtime.ordinary, maxCalls: 3 }, semantic: study.runtime.semantic, limits: study.runtime.limits } })
    const result = await runDataPhase('execute', directory)
    await writeFile(join(root, 'http-observations.json'), JSON.stringify({ calls: http.calls, errors: http.errors }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    expect(http.errors).toEqual([])
    expect(result).toMatchObject({ failed: true, completedConditions: 1, skippedConditions: ['reported', 'semantic'] })
    const runs = z.array(z.object({ condition: z.literal('N'), failed: z.literal(true), grade: z.null(), artifacts: z.unknown(),
      counts: z.object({ ordinary: z.literal(5), semantic: z.literal(0), sourceControlled: z.literal(16) }),
      cleanup: z.object({ started: z.literal(5), closed: z.literal(5), forced: z.literal(0) }) })).parse(result['results'])
    expect(runs).toHaveLength(1)
    expect(http.calls.map(call => call.kind)).toEqual(['B-initial', 'B-initial', 'C-initial', 'C-initial', 'B-mixed'])
    const output = join(directory, 'execute', 'N')
    await checkPartial(output, runs[0]?.artifacts)
    const partial = sessionSchema.parse(await readJson(join(output, 'partial-B-session.json')))
    const write = z.object({ type: z.literal('tool/call'), data: z.object({ name: z.literal('evaluation_write') }) })
    expect(partial.events.some(event => write.safeParse(event).success)).toBe(true)
    await expect(runDataPhase('execute', directory)).rejects.toThrow()
    expect(http.calls).toHaveLength(5)
  } finally {
    try { await http?.close() } finally { await retainAndRemove(root) }
  }
}, 120000)
