/** HTTP transport calibration, never a quality claim about a real model. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createDataStudy, type NativeDataStudy } from './data-study.ts'
import { executePayment, gradeDataArtifacts, parsePolicy, sealDataArtifact } from './data-artifacts.ts'
import { prepareDataStudy, runDataPhase } from './data-cli.ts'
import { runNativeData } from './native-data-run.ts'
import { openDataHttpFixture } from './data-http-fixture.ts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const enabled = process.env.DSH_NATIVE_DATA_EVALUATION === '1' && process.platform !== 'win32'
async function calibration(omitUsage: boolean, cancel?: AbortController) {
  let study: NativeDataStudy | undefined
  const http = await openDataHttpFixture((envelope) => {
    if (study === undefined) throw new Error('calibration study not configured')
    const system = JSON.stringify(envelope.messages.filter(message => message.role === 'system'))
    let reply: unknown
    let finish: 'stop' | 'tool_calls' = 'stop'
    let kind: string
    if (system.includes('Summarize the supplied authorized work reports')) {
      kind = 'semantic'
      const input = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string() })) }).parse(
        JSON.parse(z.string().parse(envelope.messages.at(-1)?.content)) as unknown)
      expect(input.sources).toHaveLength(3)
      reply = { content: JSON.stringify({ version: 1,
        decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
        updates: [{ text: 'Policy correction: maxRetries: 1. A later Edit failed and did not set nine retries.',
          sources: input.sources.map(source => ({ sourceId: source.sourceId, quote: source.body.slice(0, 40) })) }] }) }
    } else {
      const all = JSON.stringify(envelope.messages)
      const role = all.includes('Maintain client/payment-policy.json') ? 'B' : 'C'
      kind = role
      const index = envelope.messages.filter(message => message.role === 'tool').length
      const initialText = study.roles.B.initialFiles['public/payment-policy.json']
      if (initialText === undefined) throw new Error('public initial policy missing')
      const initial = parsePolicy(sealDataArtifact(initialText))
      const selected = { ...initial, maxRetries: all.includes('maxRetries: 1') ? 1 : 3 }
      const body = Object.fromEntries(initial.requiredFields.map(field => [field, 'calibration-public-value']))
      const input = { body, responses: [{ kind: 'error' as const, code: 'NETWORK_TIMEOUT' }] }
      const artifact = role === 'B' ? selected : { version: 1, cases: [
        { id: 'retry-limit', input, expected: executePayment(selected, input) },
      ] }
      const program = [
        { name: 'evaluation_read', args: { path: 'README.md' } },
        { name: 'evaluation_write', args: { path: study.roles[role].artifactPath, text: JSON.stringify(artifact) + '\n' } },
        { name: 'evaluation_test', args: {} },
      ]
      const item = program[index]
      if (item === undefined) { if (index !== program.length) throw new Error('unexpected extra ordinary call'); reply = { content: 'Calibration completed.' } }
      else { finish = 'tool_calls'; reply = { tool_calls: [{ index: 0, id: `call-${role}-${index}`, type: 'function',
        function: { name: item.name, arguments: JSON.stringify(item.args) } }] } }
    }
    return { kind, delta: z.record(z.string(), z.unknown()).parse(reply), finish,
      omitUsage: omitUsage && kind !== 'semantic', ...cancel !== undefined && kind !== 'semantic' ? { cancel } : {} }
  })
  return { ...http, configure(value: NativeDataStudy) { study = value } }
}
async function run(condition: 'N' | 'E' | 'R', omitUsage = false, smallInput = false, cancelStream = false) {
  const root = await mkdtemp(join(tmpdir(), 'native-data-spec-'))
  const cancellation = cancelStream ? new AbortController() : undefined
  const http = await calibration(omitUsage, cancellation)
  const route = { provider: 'deepseek-official' as const,
    endpointSource: { kind: 'openai-compatible-gateway' as const, name: 'local-http-calibration' }, network: { kind: 'direct' as const },
    model: 'deepseek-flash', endpoint: http.endpoint,
    apiKeyEnv: 'DSH_DATA_CALIBRATION_KEY', credentialsPath: null, maxCalls: 4, maxInputBytes: smallInput ? 1024 : 262144,
    maxOutputTokens: 2048, maxOutputBytes: 65536, timeoutMs: 15000 }
  const study = createDataStudy(20261004, { ordinary: route, semantic: { ...route, maxCalls: 2 },
    limits: { contextBytes: 16000, maxArtifactBytes: 65536, wallTimeoutMs: 90000, cleanupTimeoutMs: 10000, operationTimeoutMs: 20000 } })
  http.configure(study.runtime)
  try {
    const output = join(root, 'run')
    const result = await runNativeData({ repo, nodePath: process.execPath, output, condition, study: study.runtime,
      execution: { kind: 'transport-calibration' }, ...cancellation === undefined ? {} : { signal: cancellation.signal },
      grade: artifacts => gradeDataArtifacts({ ...artifacts, ...study.oracle }) })
    expect(http.errors).toEqual([])
    expect(result.failed, result.error ?? '').toBe(omitUsage || smallInput || cancelStream)
    expect(result.cleanup).toEqual({ started: 4, closed: 4, forced: 0 })
    expect(result.realModelDispatches).toBe(0)
    expect(result.counts.sourceControlled).toBe(7)
    expect(new Set(result.peers).size).toBe(4)
    const ledger = JSON.parse(await readFile(join(output, 'source-admission.json'), 'utf8')) as unknown
    expect(ledger).toEqual(expect.objectContaining({ reports: [expect.objectContaining({ tool: 'Write', reportedStatus: 'success' }),
      expect.objectContaining({ tool: 'Edit', reportedStatus: 'success' }), expect.objectContaining({ tool: 'Edit', reportedStatus: 'failure' })] }))
    if (cancelStream) {
      expect(result.dispatchBlocked).toBe(true)
      expect(result.counts.ordinary).toBe(1)
      expect(http.calls).toHaveLength(1)
      expect(result.roles.C).toBeUndefined()
    } else if (smallInput) {
      expect(result.counts.ordinary).toBe(0)
      expect(result.roles.B?.requests).toBe(0)
      expect(result.roles.B?.completed).toBe(false)
      expect(JSON.stringify(result.roles.B?.turnReason)).toContain('model input exceeds byte limit')
      expect(result.roles.C?.skipped).toBe(true)
      expect(http.calls).toHaveLength(0)
    } else if (omitUsage) {
      expect(result.dispatchBlocked).toBe(true)
      expect(result.counts.ordinary).toBe(1)
      expect(result.roles.C?.skipped).toBe(true)
      expect(http.calls.filter(call => call.kind !== 'semantic')).toHaveLength(1)
    } else {
      expect(result.dispatchBlocked).toBe(false)
      expect(result.counts).toEqual({ ordinary: 8, semantic: condition === 'R' ? 2 : 0, sourceControlled: 7 })
      for (const role of ['B', 'C'] as const) {
        expect(result.roles[role]?.requests).toBe(4)
        expect(result.roles[role]?.turnReason).toEqual({ kind: 'completed' })
        expect(result.roles[role]?.adoptedWatermark).toBe(condition !== 'N')
      }
      if (result.artifacts.policy === null) throw new Error('policy artifact absent')
      expect(parsePolicy(result.artifacts.policy).maxRetries).toBe(condition === 'N' ? 3 : 1)
    }
  } finally { await http.close(); await rm(root, { recursive: true, force: true }) }
}
for (const condition of ['N', 'E', 'R'] as const) {
  it.skipIf(!enabled)(`runs real source tools and ordinary HTTP-provider Sessions in ${condition}`, async () => { await run(condition) }, 110000)
}
it.skipIf(!enabled)('records missing usage and blocks another ordinary request and the next recipient', async () => { await run('E', true) }, 110000)

it.skipIf(!enabled)('records a pre-dispatch input limit failure and does not start the next recipient', async () => { await run('N', false, true) }, 110000)

it.skipIf(!enabled)('cancels an actual ordinary HTTP stream and awaits all four Host exits', async () => { await run('N', false, false, true) }, 110000)

for (const smallInput of [false, true]) {
  it.skipIf(!enabled)(`executes frozen CLI phases with ${smallInput ? 'a pre-dispatch failure' : 'independent artifact grades'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-data-driver-spec-'))
    const http = await calibration(false)
    try {
      const route = { provider: 'deepseek-official' as const,
        endpointSource: { kind: 'openai-compatible-gateway' as const, name: 'local-http-calibration' }, network: { kind: 'direct' as const },
        model: 'deepseek-flash', endpoint: http.endpoint,
        apiKeyEnv: 'DSH_DATA_CALIBRATION_KEY', credentialsPath: null, maxCalls: 4, maxInputBytes: smallInput ? 1024 : 262144,
        maxOutputTokens: 2048, maxOutputBytes: 65536, timeoutMs: 15000 }
      const config = { ordinary: route, semantic: { ...route, maxCalls: 2 }, limits: {
        contextBytes: 16000, maxArtifactBytes: 65536, wallTimeoutMs: 90000, cleanupTimeoutMs: 10000, operationTimeoutMs: 20000 } }
      http.configure(createDataStudy(20261004, config).runtime)
      const directory = join(root, 'registered')
      await prepareDataStudy({ root: directory, seed: 20261004, execution: 'transport-calibration', config })
      expect(await runDataPhase('preflight', directory)).toMatchObject({ failed: false, hostsStarted: 0, modelDispatches: 0 })
      expect(http.calls).toHaveLength(0)
      const result = await runDataPhase('execute', directory)
      expect(http.errors).toEqual([])
      expect(result.failed).toBe(smallInput)
      expect(result['completedConditions']).toBe(smallInput ? 1 : 3)
      expect(result['skippedConditions']).toEqual(smallInput ? ['E', 'R'] : [])
      const runs = z.array(z.object({ failed: z.boolean(), counts: z.object({ ordinary: z.number(), semantic: z.number() }),
        grade: z.unknown(), cleanup: z.object({ started: z.literal(4), closed: z.literal(4), forced: z.literal(0) }) })).parse(result['results'])
      expect(runs.reduce((total, run) => total + run.counts.ordinary, 0)).toBe(smallInput ? 0 : 24)
      expect(runs.reduce((total, run) => total + run.counts.semantic, 0)).toBe(smallInput ? 0 : 2)
      const source = JSON.parse(await readFile(join(directory, 'execute/N/source-admission.json'), 'utf8')) as unknown
      expect(source).toMatchObject({ sourceTaskReplicas: 0, reports: [expect.objectContaining({ tool: 'Write', reportedStatus: 'success' }),
        expect.objectContaining({ tool: 'Edit', reportedStatus: 'success' }), expect.objectContaining({ tool: 'Edit', reportedStatus: 'failure' })] })
      if (smallInput) {
        const ordinary = JSON.parse(await readFile(join(directory, 'execute/N/B-session.json'), 'utf8')) as unknown
        const result = z.object({ turnReason: z.unknown(), requests: z.array(z.unknown()) }).loose().parse(ordinary)
        expect(result.requests).toHaveLength(0)
        expect(JSON.stringify(result.turnReason)).toContain('model input exceeds byte limit')
      } else expect(runs[0]?.grade).toMatchObject({ policy: { status: 'failed' } })
      await expect(runDataPhase('execute', directory)).rejects.toThrow()
      expect(http.calls).toHaveLength(smallInput ? 0 : 26)
    } finally { await http.close(); await rm(root, { recursive: true, force: true }) }
  }, 300000)
}
