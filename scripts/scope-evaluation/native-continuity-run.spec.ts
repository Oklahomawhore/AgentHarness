/** Same live Session adoption with controlled HTTP replies, never a model-quality claim. */
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { openDataHttpFixture } from './data-http-fixture.ts'
import { parsePolicy, sealDataArtifact } from './data-artifacts.ts'
import { createContinuityStudy, gradeContinuityPhase, continuityAutomatic } from './continuity-study.ts'
import { prepareDataStudy, runDataPhase } from './data-cli.ts'
import { runNativeData } from './native-data-run.ts'
import type { NativeDataStudy } from './data-study.ts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const enabled = process.env.DSH_NATIVE_DATA_EVALUATION === '1' && process.platform !== 'win32'
type Fault = 'none' | 'stale-correction' | 'stale-withdrawal' | 'rollback-history' | 'missing-correction-usage' | 'cancel-withdrawal'
async function calibration(fault: Fault, cancellation: AbortController) {
  let study: NativeDataStudy | undefined
  const http = await openDataHttpFixture((envelope) => {
    if (study === undefined) throw new Error('continuity calibration is not configured')
    const system = JSON.stringify(envelope.messages.filter(message => message.role === 'system'))
    if (system.includes('Summarize the supplied authorized work reports')) {
      const input = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string() })) }).parse(
        JSON.parse(z.string().parse(envelope.messages.at(-1)?.content)) as unknown)
      const corrected = input.sources.some(source => source.body.includes('maxRetries: 1'))
      return { kind: 'semantic', finish: 'stop', delta: { content: JSON.stringify({ version: 1,
        decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
        updates: [{ text: corrected ? 'maxRetries: 1. Failed later edits do not change the policy.' : 'maxRetries: 3.',
          sources: input.sources.map(source => ({ sourceId: source.sourceId, quote: source.body.slice(0, 40) })) }] }) } }
    }
    const shared = envelope.messages.flatMap(message => typeof message.content === 'string' && message.role === 'user'
      && message.content.includes('## Shared scope context') ? [message.content] : []).at(-1)
    if (shared === undefined) throw new Error('automatic work lacks current shared context')
    const frame = /<(development-task-context|shared-work-updates)>\n([\s\S]*?)\n<\/\1>/
    const framed = frame.exec(shared)?.[2]
    if (framed === undefined) throw new Error('current context lacks a complete data frame')
    const payload = z.object({ publications: z.array(z.unknown()).optional(), mandatory: z.array(z.unknown()).optional() })
      .loose().parse(JSON.parse(framed) as unknown)
    const endedPublication = z.object({ peerContribution: z.object({ ended: z.enum(['revoked', 'left', 'expired']) }) })
    const withdrawn = (payload.publications ?? []).some(item => endedPublication.safeParse(item).success)
      || (payload.mandatory ?? []).some(item => z.object({ kind: z.literal('withdrawal') }).safeParse(item).success)
    const phase = withdrawn ? 'withdrawn' : framed.includes('maxRetries: 1') ? 'corrected' : 'initial'
    const initialText = study.roles.B.initialFiles['public/payment-policy.json']
    if (initialText === undefined) throw new Error('public baseline absent')
    const initial = parsePolicy(sealDataArtifact(initialText))
    const selected = { ...initial, maxRetries: phase === 'initial' || fault === 'stale-correction' ? 3 : 1 }
    const decision = withdrawn && fault !== 'stale-withdrawal'
      ? { version: 1, status: 'blocked', reason: 'current-evidence-unavailable' }
      : { version: 1, status: 'ready', policy: selected }
    const program = [
      ...withdrawn && fault === 'rollback-history' ? [{ name: 'evaluation_write',
        args: { path: study.roles.B.artifactPath, text: JSON.stringify(initial) + '\n' } }] : [],
      ...withdrawn ? [] : [{ name: 'evaluation_write', args: { path: study.roles.B.artifactPath, text: JSON.stringify(selected) + '\n' } }],
      { name: 'evaluation_write', args: { path: 'current-work.json', text: JSON.stringify(decision) + '\n' } },
      ...withdrawn ? [] : [{ name: 'evaluation_test', args: {} }],
    ]
    const start = envelope.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string'
      && message.content.includes('Shared scope changed. Continue the authorized goal'))
    if (start < 0) throw new Error('continuous work was not scheduled by an automatic pulse')
    const index = envelope.messages.slice(start).filter(message => message.role === 'tool').length
    const item = program[index]
    if (index > program.length) throw new Error('unexpected extra automatic request')
    return { kind: phase, finish: item === undefined ? 'stop' : 'tool_calls',
      delta: item === undefined ? { content: 'Controlled continuity work completed.' } : { tool_calls: [
        { index: 0, id: `call-${phase}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } }] },
      omitUsage: fault === 'missing-correction-usage' && phase === 'corrected',
      ...fault === 'cancel-withdrawal' && withdrawn ? { cancel: cancellation } : {} }
  })
  return { ...http, configure(value: NativeDataStudy) { study = value } }
}

async function run(condition: 'E' | 'R', fault: Fault = 'none', driver = false) {
  const root = await mkdtemp(join(tmpdir(), 'native-continuity-spec-'))
  const cancellation = new AbortController()
  const http = await calibration(fault, cancellation)
  const route = { provider: 'deepseek-official' as const,
    endpointSource: { kind: 'openai-compatible-gateway' as const, name: 'local-http-calibration' }, network: { kind: 'direct' as const },
    model: 'controlled-http-replies', endpoint: http.endpoint,
    apiKeyEnv: 'DSH_DATA_CALIBRATION_KEY', credentialsPath: null, maxCalls: 12, maxInputBytes: 262144,
    maxOutputTokens: 2048, maxOutputBytes: 65536, timeoutMs: 20000 }
  const config = { ordinary: route, semantic: route, limits: { contextBytes: 16000, maxArtifactBytes: 65536,
    wallTimeoutMs: 120000, cleanupTimeoutMs: 10000, operationTimeoutMs: 30000 } }
  const study = createContinuityStudy(20261004, config)
  http.configure(study.runtime)
  try {
    if (driver) {
      const directory = join(root, 'registered')
      await prepareDataStudy({ root: directory, seed: 20261004, execution: 'transport-calibration', config, protocol: 'continuity' })
      expect(await runDataPhase('preflight', directory)).toMatchObject({ failed: false, hostsStarted: 0, modelDispatches: 0 })
      expect(http.calls).toHaveLength(0)
      const result = await runDataPhase('execute', directory)
      expect(result).toMatchObject({ failed: false, completedConditions: 2, skippedConditions: [] })
      const results = z.array(z.object({ continuity: z.object({ phases: z.array(z.object({ grade: z.object({ status: z.string() }) })) }) })).parse(result['results'])
      expect(results.flatMap(result => result.continuity.phases.map(phase => phase.grade.status))).toEqual(Array<string>(6).fill('passed'))
      const count = http.calls.length
      await expect(runDataPhase('execute', directory)).rejects.toThrow()
      expect(http.calls).toHaveLength(count)
      return
    }
    const output = join(root, 'run')
    const result = await runNativeData({ repo, nodePath: process.execPath, output, condition, study: study.runtime,
      execution: { kind: 'transport-calibration' }, signal: cancellation.signal,
      continuity: { decisionPath: 'current-work.json', automatic: continuityAutomatic,
        grade: (phase, artifacts) => gradeContinuityPhase({ phase, ...artifacts, oracle: study.oracle }) } })
    expect(http.errors).toEqual([])
    expect(result.failed, result.error ?? '').toBe(fault === 'missing-correction-usage' || fault === 'cancel-withdrawal')
    expect(result.cleanup).toEqual({ started: 3, closed: 3, forced: 0 })
    expect(result.realModelDispatches).toBe(0)
    expect(result.roles.C).toBeUndefined()
    const phases = result.continuity?.phases ?? []
    if (fault === 'missing-correction-usage' || fault === 'cancel-withdrawal') {
      expect(result.dispatchBlocked).toBe(true)
      expect(phases.map(phase => phase.phase)).toEqual(fault === 'missing-correction-usage' ? ['initial'] : ['initial', 'corrected'])
      expect(http.calls.filter(call => call.kind === (fault === 'missing-correction-usage' ? 'corrected' : 'withdrawn'))).toHaveLength(1)
      return
    }
    expect(result.counts.ordinary).toBe(fault === 'rollback-history' ? 11 : 10)
    expect(result.counts.sourceControlled).toBe(7)
    expect(result.dispatchBlocked).toBe(false)
    expect(phases.map(phase => phase.phase)).toEqual(['initial', 'corrected', 'withdrawn'])
    expect(new Set(phases.map(phase => phase.agentId)).size).toBe(1)
    expect(new Set(phases.map(phase => phase.sessionId)).size).toBe(1)
    expect(phases.map(phase => [phase.requestStart, phase.requestEnd])).toEqual([[0, 4], [4, 8], [8, fault === 'rollback-history' ? 11 : 10]])
    if (fault === 'rollback-history') expect(phases[2]?.artifacts.policy?.sha256).toBe(phases[0]?.artifacts.policy?.sha256)
    else expect(phases[2]?.artifacts.policy?.sha256).toBe(phases[1]?.artifacts.policy?.sha256)
    expect(phases.map(phase => z.object({ status: z.string() }).parse(phase.grade).status)).toEqual(
      ['passed', fault === 'stale-correction' ? 'failed' : 'passed', fault === 'stale-withdrawal' || fault === 'rollback-history' ? 'failed' : 'passed'])
    expect(phases[0]?.ownerRevision).toBeLessThan(phases[1]?.ownerRevision ?? 0)
    expect(phases[1]?.ownerRevision).toBeLessThan(phases[2]?.ownerRevision ?? 0)
    const observation = z.object({ events: z.array(z.object({ type: z.string(), data: z.unknown() })),
      requests: z.array(z.object({ messages: z.array(z.unknown()) })) }).loose().parse(
      JSON.parse(await readFile(join(output, 'withdrawn-B-session.json'), 'utf8')) as unknown)
    const userMessages = observation.events.filter(event => event.type === 'user/message')
      .map(event => z.object({ source: z.object({ kind: z.string() }).loose() }).loose().parse(event.data))
    expect(userMessages.filter(message => message.source.kind === 'scope-agent-pulse')).toHaveLength(3)
    expect(userMessages.some(message => message.source.kind === 'user')).toBe(false)
    const snapshotSchema = z.object({ source: z.object({ kind: z.literal('scope-agent-context'), form: z.literal('snapshot'),
      projection: z.object({ text: z.string(), selectedSources: z.array(z.object({ kind: z.string() }).loose()),
        omittedSources: z.array(z.object({ reason: z.string() }).loose()) }).loose() }).loose() }).loose()
    const finalSnapshots = observation.requests.at(-1)?.messages.flatMap((message) => {
      const value = snapshotSchema.safeParse(message)
      return value.success ? [value.data.source.projection] : []
    }) ?? []
    expect(finalSnapshots).toHaveLength(1)
    expect(finalSnapshots[0]?.selectedSources.filter(source => source.kind === 'publication')).toHaveLength(1)
    expect(finalSnapshots[0]?.omittedSources.filter(source => source.reason === 'withdrawn')).toHaveLength(3)
    expect(finalSnapshots[0]?.text).not.toContain('maxRetries: 1')
    expect(finalSnapshots[0]?.text).not.toContain('maxRetries: 3')
    expect(http.calls.filter(call => call.kind === 'semantic').length).toBe(condition === 'E' ? 0 : result.counts.semantic)
  } finally {
    try {
      await http.close()
      const evidence = process.env.DSH_CONTINUITY_EVIDENCE_ROOT
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true, mode: 0o700 })
        await cp(root, join(evidence, basename(root)), { recursive: true, errorOnExist: true, force: false })
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}
for (const condition of ['E', 'R'] as const) {
  it.skipIf(!enabled)(`continues one existing ${condition} Session after source correction and contribution withdrawal`, async () => { await run(condition) }, 150000)
}
for (const fault of ['stale-correction', 'stale-withdrawal', 'rollback-history', 'missing-correction-usage', 'cancel-withdrawal'] as const) {
  it.skipIf(!enabled)(`distinguishes automatic runtime continuity from ${fault}`, async () => { await run('E', fault) }, 150000)
}
it.skipIf(!enabled)('executes the frozen E/R continuity entry once without resetting per-Session budgets', async () => { await run('E', 'none', true) }, 300000)
