import { describe, expect, it } from 'vitest'
import { parseDataStudyConfig } from './data-study.ts'
import { parsePolicy, sealDataArtifact, type PaymentPolicy } from './data-artifacts.ts'
import {
  continuityAutomatic, continuityConditions, continuityDecisionJsonSchema, createContinuityStudy,
  gradeContinuityPhase, parseContinuityDecision, type ContinuityPhase,
} from './continuity-study.ts'

const route = { provider: 'deepseek-official', model: 'registered-model', endpoint: 'https://api.deepseek.com/',
  apiKeyEnv: 'EVALUATION_API_KEY', credentialsPath: null,
  maxCalls: 12, maxInputBytes: 32768, maxOutputTokens: 2048, maxOutputBytes: 16384, timeoutMs: 30000 }
const config = parseDataStudyConfig({ ordinary: route, semantic: { ...route, maxCalls: 2 },
  limits: { contextBytes: 8192, maxArtifactBytes: 32768, wallTimeoutMs: 300000,
    cleanupTimeoutMs: 10000, operationTimeoutMs: 30000 } }, 'live')
const seal = (value: unknown) => sealDataArtifact(JSON.stringify(value))
const ready = (policy: PaymentPolicy) => seal({ version: 1, status: 'ready', policy })
const blocked = seal({ version: 1, status: 'blocked', reason: 'current-evidence-unavailable' })

describe('continuing task public project', () => {
  it('declares current-work permission from the first goal without revealing the later answer or private inputs', () => {
    const { runtime, oracle } = createContinuityStudy(61, config)
    const project = runtime.roles.B
    expect(runtime.id).toBe('payment-policy-continuity-v1')
    expect(runtime.decisionPath).toBe('current-work.json')
    expect(project.writableFiles).toEqual([project.artifactPath, runtime.decisionPath])
    expect(project.readableFiles.slice().sort()).toEqual(Object.keys(project.initialFiles).sort())
    expect(project.goal).toContain('same Session')
    expect(project.goal).toContain('retain the existing policy')
    const current = project.initialFiles[runtime.decisionPath]
    const policy = project.initialFiles[project.artifactPath]
    if (current === undefined || policy === undefined) throw new Error('public artifacts missing')
    expect(parseContinuityDecision(sealDataArtifact(current)).status).toBe('blocked')
    expect(parsePolicy(sealDataArtifact(policy)).maxRetries).toBe(3)
    const visible = JSON.stringify({ goal: project.goal, files: project.initialFiles })
    expect(visible).not.toContain('maxRetries: 1')
    expect(visible).not.toContain('maxRetries: 9')
    expect(visible).not.toContain('payment-json-hidden')
    expect(visible).not.toContain('obsolete-three-retries')
    for (const input of oracle.corrected.hiddenInputs) {
      if (input.body === null) continue
      for (const value of Object.values(input.body)) {
        if (typeof value === 'string' && /^(order|account)-/.test(value)) expect(visible).not.toContain(value)
      }
    }
    expect(project.readableFiles).not.toContain(runtime.source.path)
    expect(project.readableFiles).not.toContain(runtime.roles.C.artifactPath)
    expect(continuityConditions).toEqual(['E', 'R'])
    expect(continuityAutomatic).toEqual({ activationLimit: 3, maxStepsPerTurn: 4, minIntervalMs: 0 })
  })

  it('reproduces one study while keeping the initial and corrected references separate', () => {
    const first = createContinuityStudy(62, config)
    expect(createContinuityStudy(62, config)).toEqual(first)
    expect(first.oracle.initial.reference.maxRetries).toBe(3)
    expect(first.oracle.corrected.reference.maxRetries).toBe(1)
    expect(first.runtime.source.expectedContent).toContain('maxRetries: 1')
    expect(first.oracle.initial.hiddenInputs).toEqual(first.oracle.corrected.hiddenInputs)
    expect(first.oracle.initial.hiddenInputs).not.toBe(first.oracle.corrected.hiddenInputs)
  })

  it('publishes a closed decision schema with complete policy validation and no score field', () => {
    const text = JSON.stringify(continuityDecisionJsonSchema)
    expect(text).toContain('"additionalProperties":false')
    expect(text).toContain('"maxRetries"')
    expect(text).toContain('"maximum":10')
    expect(text).toContain('current-evidence-unavailable')
    expect(text).not.toContain('"score"')
  })
})

describe('closed current-work data', () => {
  it('validates the embedded policy through its owner and retains exact sealed byte identity', () => {
    const { oracle } = createContinuityStudy(63, config)
    const policy = oracle.corrected.reference
    const compact = ready(policy)
    const spaced = sealDataArtifact('\n' + JSON.stringify({ version: 1, status: 'ready', policy }, null, 2) + '\n')
    expect(parseContinuityDecision(compact)).toEqual(parseContinuityDecision(spaced))
    expect(compact.sha256).not.toBe(spaced.sha256)
    expect(() => parseContinuityDecision({ ...compact, sha256: '0'.repeat(64) })).toThrow('integrity')
    expect(() => parseContinuityDecision(sealDataArtifact(compact.text + ' '.repeat(65_536)))).toThrow('byte-limit')
    expect(() => parseContinuityDecision(sealDataArtifact('not JSON'))).toThrow('json')
  })

  it.each([
    { version: 1, status: 'ready' },
    { version: 1, status: 'ready', policy: null },
    { version: 1, status: 'ready', policy: { version: 1, requiredFields: ['x'], maxRetries: 11, retryableErrors: [] } },
    { version: 1, status: 'blocked' },
    { version: 1, status: 'blocked', reason: 'all-tests-pass' },
    { version: 1, status: 'blocked', reason: 'current-evidence-unavailable', pass: true },
    { version: 1, status: 'blocked', reason: 'current-evidence-unavailable', policy: {} },
  ])('rejects incomplete or self-scored decision %#', (value) => {
    expect(() => parseContinuityDecision(seal(value))).toThrow('schema')
  })
})

describe('independent continuous phase outcomes', () => {
  it('grades actual initial and corrected behavior before accepting a blocked withdrawal with the old file retained', () => {
    const { oracle } = createContinuityStudy(64, config)
    const initial = seal(oracle.initial.reference)
    const corrected = seal(oracle.corrected.reference)
    const a = gradeContinuityPhase({ previousPolicy: null, phase: 'initial', policy: initial, decision: ready(oracle.initial.reference), oracle })
    const b = gradeContinuityPhase({ previousPolicy: null, phase: 'corrected', policy: corrected, decision: ready(oracle.corrected.reference), oracle })
    const c = gradeContinuityPhase({ previousPolicy: corrected, phase: 'withdrawn', policy: corrected, decision: blocked, oracle })
    expect([a.status, b.status, c.status]).toEqual(['passed', 'passed', 'passed'])
    for (const grade of [a, b]) {
      expect(grade.execution.kind).toBe('evaluated')
      if (grade.execution.kind !== 'evaluated') throw new Error('missing independent behavior')
      expect(grade.execution.checks).toHaveLength(oracle.initial.hiddenInputs.length)
      expect(grade.execution.checks.every(check => check.passed)).toBe(true)
      expect(grade.mutantWitnesses.every(mutant => mutant.inputIndices.length > 0)).toBe(true)
    }
    expect(c.execution).toEqual({ kind: 'blocked', requests: [] })
    expect(c.mutantWitnesses).toEqual([])
    expect(c.artifacts.policy).toEqual(b.artifacts.policy)
    expect(a.artifacts.policy?.sha256).toBe(initial.sha256)
    expect(a.artifacts.policy?.sha256).not.toBe(b.artifacts.policy?.sha256)
    expect(c.artifacts.decision?.sha256).toBe(blocked.sha256)
  })

  it.each(['initial', 'corrected'] as const)('rejects each behavior mutant in %s without using self-reported readiness as success', (phase) => {
    const { oracle } = createContinuityStudy(65, config)
    for (const mutant of oracle[phase].mutants) {
      const grade = gradeContinuityPhase({ previousPolicy: null, phase, policy: seal(mutant.policy),
        decision: ready(mutant.policy), oracle })
      expect(grade.status, mutant.id).toBe('failed')
      expect(grade.failure).toBe('policy-behavior')
      expect(grade.execution.kind).toBe('evaluated')
      if (grade.execution.kind !== 'evaluated') throw new Error('mutant not evaluated')
      expect(grade.execution.checks.some(check => !check.passed)).toBe(true)
    }
  })

  it('rejects a correct embedded answer when the separately sealed working policy was not updated', () => {
    const { oracle } = createContinuityStudy(66, config)
    const result = gradeContinuityPhase({ previousPolicy: null, phase: 'corrected', policy: seal(oracle.initial.reference),
      decision: ready(oracle.corrected.reference), oracle })
    expect(result).toMatchObject({ status: 'failed', failure: 'decision-policy-mismatch', execution: { kind: 'not-evaluated' } })
  })

  it.each(['initial', 'corrected'] as const)('rejects always-blocked work in authorized phase %s', (phase) => {
    const { oracle } = createContinuityStudy(67, config)
    expect(gradeContinuityPhase({ previousPolicy: null, phase, policy: seal(oracle[phase].reference), decision: blocked, oracle }))
      .toMatchObject({ status: 'failed', failure: 'blocked-with-current-support', execution: { kind: 'blocked', requests: [] } })
  })

  it('does not accept old readiness after withdrawal or execute the retained policy on new payment inputs', () => {
    const { oracle } = createContinuityStudy(68, config)
    expect(gradeContinuityPhase({ previousPolicy: seal(oracle.corrected.reference), phase: 'withdrawn',
      policy: seal(oracle.corrected.reference),
      decision: ready(oracle.corrected.reference), oracle }))
      .toMatchObject({ status: 'failed', failure: 'ready-without-current-support', execution: { kind: 'not-evaluated' } })
  })

  it('rejects a withdrawal rollback or formatting rewrite against the previous independent seal', () => {
    const { oracle } = createContinuityStudy(71, config)
    const previousPolicy = seal(oracle.corrected.reference)
    for (const policy of [seal(oracle.initial.reference),
      sealDataArtifact(JSON.stringify(oracle.corrected.reference, null, 2) + '\n')]) {
      const result = gradeContinuityPhase({ phase: 'withdrawn', previousPolicy, policy, decision: blocked, oracle })
      expect(result).toMatchObject({ status: 'failed', failure: 'historical-policy-changed',
        execution: { kind: 'blocked', requests: [] } })
    }
  })

  it('preserves any legally structured previous work without demanding a hidden final value', () => {
    const { oracle } = createContinuityStudy(72, config)
    for (const maxRetries of [0, 3, 9, 10]) {
      const previousPolicy = sealDataArtifact(JSON.stringify({ ...oracle.initial.reference, maxRetries }, null, 2) + '\n')
      const result = gradeContinuityPhase({ phase: 'withdrawn', previousPolicy,
        policy: sealDataArtifact(previousPolicy.text), decision: blocked, oracle })
      expect(result.status).toBe('passed')
      expect(result.execution).toEqual({ kind: 'blocked', requests: [] })
      expect(result.artifacts.policy?.sha256).toBe(previousPolicy.sha256)
    }
  })

  it('rejects corrupted prior seals as parent integrity errors', () => {
    const { oracle } = createContinuityStudy(73, config)
    const policy = seal(oracle.corrected.reference)
    for (const previousPolicy of [{ ...policy, sha256: '0'.repeat(64) }, { ...policy, bytes: policy.bytes + 1 }]) {
      expect(() => gradeContinuityPhase({ phase: 'withdrawn', policy, previousPolicy, decision: blocked, oracle }))
        .toThrow('previous policy seal integrity failed')
    }
  })

  it('keeps malformed previous candidates as artifact failures rather than oracle errors', () => {
    const { oracle } = createContinuityStudy(74, config)
    for (const previousPolicy of [sealDataArtifact('not JSON'), seal({ ...oracle.corrected.reference, maxRetries: 11 })]) {
      const retained = gradeContinuityPhase({ phase: 'withdrawn', previousPolicy,
        policy: sealDataArtifact(previousPolicy.text), decision: blocked, oracle })
      expect(retained.status).toBe('invalid')
      expect(retained.execution).toEqual({ kind: 'not-evaluated' })
      const changed = gradeContinuityPhase({ phase: 'withdrawn', previousPolicy,
        policy: seal(oracle.corrected.reference), decision: blocked, oracle })
      expect(changed).toMatchObject({ status: 'failed', failure: 'historical-policy-changed',
        execution: { kind: 'blocked', requests: [] } })
    }
  })

  it('does not certify retention when the previous phase had no policy file', () => {
    const { oracle } = createContinuityStudy(75, config)
    expect(gradeContinuityPhase({ phase: 'withdrawn', previousPolicy: null,
      policy: seal(oracle.corrected.reference), decision: blocked, oracle }))
      .toMatchObject({ status: 'failed', failure: 'historical-policy-unavailable', execution: { kind: 'not-evaluated' } })
    expect(gradeContinuityPhase({ phase: 'withdrawn', previousPolicy: null, policy: null, decision: blocked, oracle }))
      .toMatchObject({ status: 'invalid', errors: { policy: 'missing' }, execution: { kind: 'not-evaluated' } })
  })

  it('keeps missing or illegal artifacts distinct from a legitimate blocked work decision', () => {
    const { oracle } = createContinuityStudy(69, config)
    for (const phase of ['initial', 'corrected', 'withdrawn'] satisfies ContinuityPhase[]) {
      expect(gradeContinuityPhase({ previousPolicy: seal(oracle.initial.reference), phase, policy: null, decision: blocked, oracle }))
        .toMatchObject({ status: 'invalid', errors: { policy: 'missing' }, execution: { kind: 'not-evaluated' } })
      expect(gradeContinuityPhase({ previousPolicy: seal(oracle.initial.reference),
        phase, policy: seal(oracle.initial.reference), decision: null, oracle }))
        .toMatchObject({ status: 'invalid', errors: { decision: 'missing' }, execution: { kind: 'not-evaluated' } })
    }
  })

  it('fails the oracle itself when hidden input or mutant discrimination is absent', () => {
    const { oracle } = createContinuityStudy(70, config)
    const request = { phase: 'initial' as const, policy: seal(oracle.initial.reference),
      decision: ready(oracle.initial.reference), oracle }
    expect(() => gradeContinuityPhase({ previousPolicy: null, ...request,
      oracle: { ...oracle, initial: { ...oracle.initial, hiddenInputs: [] } } })).toThrow('requires hidden inputs')
    expect(() => gradeContinuityPhase({ previousPolicy: null, ...request,
      oracle: { ...oracle, initial: { ...oracle.initial, mutants: [{ id: 'identical', policy: oracle.initial.reference }] } } }))
      .toThrow('indistinguishable mutant')
  })
})
