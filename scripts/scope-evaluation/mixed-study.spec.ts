/** Mixed protocol registration and parent-only artifact grading require no model or credential access. */
import { describe, expect, it } from 'vitest'
import { DataArtifactError, executePayment, parseCases, parsePolicy, sealDataArtifact,
  type PaymentCases, type SealedDataArtifact } from './data-artifacts.ts'
import { createDataStudy, dataStudyConditions, parseDataStudyConfig } from './data-study.ts'
import { createContinuityStudy, continuityConditions } from './continuity-study.ts'
import { createMixedStudy, gradeMixedArtifacts, mixedDocuments, mixedStudyConditions,
  parseMixedStudyConfig, parseMixedVerification, type MixedArtifactGradeRequest, type MixedVerification } from './mixed-study.ts'

const route = { provider: 'deepseek-official', endpointSource: { kind: 'deepseek-official' }, network: { kind: 'direct' },
  model: 'registered-model', endpoint: 'https://api.deepseek.com/', apiKeyEnv: 'MIXED_STUDY_KEY',
  credentialsPath: '/nonexistent/mixed-study-credentials.yaml', maxCalls: 3, maxInputBytes: 32768,
  maxOutputTokens: 2048, maxOutputBytes: 16384, timeoutMs: 30000 }
const config = { ordinary: route, semantic: { ...route, maxCalls: 2 }, limits: { contextBytes: 8000,
  maxArtifactBytes: 32768, wallTimeoutMs: 300000, cleanupTimeoutMs: 10000, operationTimeoutMs: 30000 } }
const seal = (value: unknown): SealedDataArtifact => sealDataArtifact(JSON.stringify(value))
const unavailable: MixedVerification = { version: 1, status: 'unavailable', exitCode: null }
const passed: MixedVerification = { version: 1, status: 'passed', exitCode: 0 }
const failed: MixedVerification = { version: 1, status: 'failed', exitCode: 7 }

function correctRequest(): MixedArtifactGradeRequest {
  const { oracle } = createMixedStudy(20261004, parseMixedStudyConfig(config, 'live'))
  const cases: PaymentCases = { version: 1, cases: oracle.hiddenInputs.map((input, index) => ({
    id: `case-${index}`, input, expected: executePayment(oracle.reference, input),
  })) }
  return { condition: 'semantic', oracle, policy: seal(oracle.reference), cases: seal(cases),
    verification: { B: seal(failed), C: seal(failed) }, visibleVerification: { B: 7, C: 7 } }
}

describe('fixed mixed study registration', () => {
  it('uses the fixed complete budget and detaches routes without accessing the named credentials', () => {
    const input = structuredClone(config)
    const parsed = parseMixedStudyConfig(input, 'live')
    input.ordinary.model = 'changed'
    input.limits.contextBytes = 8192
    expect(parsed.ordinary.model).toBe('registered-model')
    expect(parsed.ordinary.credentialsPath).toBe('/nonexistent/mixed-study-credentials.yaml')
    expect(parsed.limits.contextBytes).toBe(8000)
  })

  it.each([2048, 7080, 8192, 16384, 32768])('rejects context budget %i at registration and study construction', (contextBytes) => {
    const selected = { ...config, limits: { ...config.limits, contextBytes } }
    expect(() => parseMixedStudyConfig(selected, 'live')).toThrow('exactly 8000')
    expect(() => createMixedStudy(1, parseDataStudyConfig(selected, 'live'))).toThrow('exactly 8000')
  })

  it('retains strict provenance and route validation for calibration and live execution', () => {
    const local = { ...route, endpoint: 'http://127.0.0.1:12345/v1', credentialsPath: null }
    const calibration = { ...config, ordinary: local, semantic: local }
    expect(parseMixedStudyConfig(calibration, 'transport-calibration').ordinary).toEqual(local)
    expect(() => parseMixedStudyConfig(calibration, 'live')).toThrow('execution provenance')
    expect(() => parseMixedStudyConfig({ ...config, ordinary: { ...route, apiKey: 'not-a-credential' } }, 'live')).toThrow()
    expect(() => parseMixedStudyConfig({ ...config, semantic: { ...route, maxCalls: 1 } }, 'live')).toThrow('both recipient')
  })

  it('keeps earlier protocols intact and reuses the same public aliases and independent behavior oracle', () => {
    const parsed = parseMixedStudyConfig(config, 'live')
    const base = createDataStudy(20261004, parsed)
    const mixed = createMixedStudy(20261004, parsed)
    expect(mixedStudyConditions).toEqual(['N', 'reported', 'semantic'])
    expect(dataStudyConditions).toEqual(['N', 'E', 'R'])
    expect(continuityConditions).toEqual(['E', 'R'])
    expect(base.runtime.id).toBe('payment-json-work-v1')
    expect(createContinuityStudy(20261004, parsed).runtime.id).toBe('payment-policy-continuity-v1')
    expect(mixed.runtime.id).toBe('payment-mixed-work-v1')
    expect(mixed.oracle).toEqual({ ...base.oracle, latestObservedExitCode: 7 })
    expect(mixed.runtime.source.initialContent).toBe(base.runtime.source.initialContent)
    expect(mixed.runtime.source.correction).toEqual(base.runtime.source.correction)
    expect(mixed.runtime.source.expectedContent).toBe(base.runtime.source.expectedContent)
    expect(mixed.runtime.source).not.toHaveProperty('failedEdit')
    expect(mixed.runtime.source.command).toBe('node verify.cjs')
    for (const role of ['B', 'C'] as const) {
      const before = base.runtime.roles[role]
      const after = mixed.runtime.roles[role]
      expect(after.artifactPath).toBe(before.artifactPath)
      expect(after.initialFiles[after.artifactPath]).toBe(before.initialFiles[before.artifactPath])
      expect(after.readableFiles).toEqual([...before.readableFiles, 'verification.schema.json', 'verification.json'])
      expect(after.writableFiles).toEqual([...before.writableFiles, 'verification.json'])
      expect(after.goal).toContain('latest authorized')
      expect(after.initialFiles['README.md']).not.toContain('Write only your assigned JSON artifact.')
      const verification = after.initialFiles['verification.json']
      if (verification === undefined) throw new Error('Expected the initial verification file')
      expect(parseMixedVerification(sealDataArtifact(verification))).toEqual(unavailable)
    }
    const initialText = mixed.runtime.roles.B.initialFiles[mixed.runtime.roles.B.artifactPath]
    if (initialText === undefined) throw new Error('Expected the initial client policy')
    const initial = parsePolicy(sealDataArtifact(initialText))
    expect(initial.maxRetries).toBe(3)
    expect(initial.requiredFields).toEqual(base.oracle.reference.requiredFields)
    expect(initial.requiredFields).not.toEqual(['orderId', 'accountId'])
  })

  it('retains ordinary document bodies and a real overwrite without exposing oracle outcomes to recipients', () => {
    const { runtime, oracle } = createMixedStudy(20261004, parseMixedStudyConfig(config, 'live'))
    expect(runtime.source.documents).toHaveLength(3)
    for (const [index, document] of runtime.source.documents.entries()) {
      const template = mixedDocuments[index]
      if (template === undefined) throw new Error('Expected the frozen document fixture')
      expect(document.content).toBe(template[1] + template[2].join('\n\n') + '\n')
      expect(Buffer.byteLength(document.content)).toBeGreaterThan(800)
      expect(Buffer.byteLength(document.content)).toBeLessThan(1400)
    }
    const overwrite = runtime.source.documentOverwrite
    const original = runtime.source.documents.find(document => document.path === overwrite.path)
    if (original === undefined) throw new Error('Expected the overwritten document')
    expect(original.content.split(overwrite.oldString)).toHaveLength(2)
    expect(original.content.replace(overwrite.oldString, overwrite.newString)).not.toBe(original.content)
    expect(JSON.stringify(runtime)).not.toContain('latestObservedExitCode')
    expect(JSON.stringify(runtime)).not.toContain('hiddenInputs')
    const visible = JSON.stringify(runtime.roles)
    expect(visible).not.toContain('MIXED_PRIVATE_CHECK_IMPLEMENTATION')
    expect(visible).not.toContain('CHECK_CURRENT_FAILED')
    expect(visible).not.toContain('"exitCode":7')
    const hiddenBody = oracle.hiddenInputs[0]?.body
    if (hiddenBody === undefined || hiddenBody === null) throw new Error('Expected a private grading body')
    for (const value of Object.values(hiddenBody)) {
      if (typeof value === 'string' && value.startsWith('order-')) expect(visible).not.toContain(value)
    }
    expect(createMixedStudy(20261004, parseMixedStudyConfig(config, 'live'))).toEqual({ runtime, oracle })
  })
})

describe('sealed mixed verification declarations', () => {
  it.each([unavailable, passed, failed, { version: 1, status: 'failed', exitCode: -9 }])('parses %j without changing its seal', (value) => {
    const artifact = seal(value)
    expect(parseMixedVerification(artifact)).toEqual(value)
    expect(artifact).toEqual(seal(value))
  })

  it.each([
    { version: 2, status: 'failed', exitCode: 7 }, { version: 1, status: 'passed', exitCode: 7 },
    { version: 1, status: 'failed', exitCode: 0 }, { version: 1, status: 'unavailable', exitCode: 7 },
    { version: 1, status: 'failed', exitCode: null }, { version: 1, status: 'failed', exitCode: 0.5 },
    { version: 1, status: 'failed', exitCode: 7, score: 1 }, { version: 1, status: 'unavailable' }, null, [],
  ])('rejects a malformed or self-scored declaration %j', (value) => {
    expect(() => parseMixedVerification(seal(value))).toThrow('schema')
  })

  it('rejects changed bytes, malformed JSON, invalid UTF-8 and oversized complete artifacts', () => {
    const artifact = seal(failed)
    expect(() => parseMixedVerification({ ...artifact, bytes: artifact.bytes + 1 })).toThrow('integrity')
    expect(() => parseMixedVerification({ ...artifact, sha256: '0'.repeat(64) })).toThrow('integrity')
    expect(() => parseMixedVerification(sealDataArtifact('{'))).toThrow('json')
    expect(() => parseMixedVerification({ text: '\ud800', bytes: 3, sha256: '0'.repeat(64) })).toThrow('invalid-utf8')
    expect(() => parseMixedVerification(sealDataArtifact(' '.repeat(65_537)))).toThrow('byte-limit')
  })
})

describe('independent mixed artifact grading', () => {
  it('requires correct policy, useful independent QA and exact current observations for both roles', () => {
    const grade = gradeMixedArtifacts(correctRequest())
    expect(grade.data.pairStatus).toBe('passed')
    expect(grade.verification.B.status).toBe('passed')
    expect(grade.verification.C.status).toBe('passed')
    expect(grade.currentEvidenceAvailable).toEqual({ B: true, C: true })
    expect(grade.pairStatus).toBe('passed')
  })

  it('rejects stale three-retry behavior independently of a correct reported command failure', () => {
    const request = correctRequest()
    const initial = { ...request.oracle.reference, maxRetries: 3 }
    const grade = gradeMixedArtifacts({ ...request, policy: seal(initial) })
    expect(grade.data.policy.status).toBe('failed')
    expect(grade.data.tests.status).toBe('passed')
    expect(grade.verification.B.status).toBe('passed')
    expect(grade.pairStatus).toBe('failed')
  })

  it('rejects stale exit zero and guessed failure values even when policy and QA pass', () => {
    const request = correctRequest()
    const grade = gradeMixedArtifacts({ ...request, verification: { B: seal(passed), C: seal({ ...failed, exitCode: 8 }) } })
    expect(grade.data.pairStatus).toBe('passed')
    expect(grade.verification.B).toMatchObject({ status: 'failed', error: null, expected: failed, reported: passed })
    expect(grade.verification.C.status).toBe('failed')
    expect(grade.pairStatus).toBe('failed')
  })

  it.each(['N', 'reported', 'semantic'] as const)('separates truthful unavailable results from completion in %s', (condition) => {
    const request = { ...correctRequest(), condition, visibleVerification: { B: null, C: null },
      verification: { B: seal(unavailable), C: seal(unavailable) } }
    const grade = gradeMixedArtifacts(request)
    expect(grade.data.pairStatus).toBe('passed')
    expect(grade.verification.B.status).toBe('passed')
    expect(grade.verification.C.status).toBe('passed')
    expect(grade.currentEvidenceAvailable).toEqual({ B: false, C: false })
    expect(grade.pairStatus).toBe('failed')
    expect(gradeMixedArtifacts({ ...request, verification: { B: seal(failed), C: seal(passed) } })
      .verification.B.status).toBe('failed')
  })

  it('rejects shared evidence attributed to N and grades an observed historical zero without calling it current', () => {
    expect(() => gradeMixedArtifacts({ ...correctRequest(), condition: 'N' })).toThrow('cannot have shared')
    const grade = gradeMixedArtifacts({ ...correctRequest(), visibleVerification: { B: 0, C: 7 },
      verification: { B: seal(passed), C: seal(failed) } })
    expect(grade.verification.B.status).toBe('passed')
    expect(grade.currentEvidenceAvailable).toEqual({ B: false, C: true })
    expect(grade.pairStatus).toBe('failed')
  })

  it('keeps absent, invalid-seal and malformed artifacts distinct from valid behavioral failures', () => {
    const request = correctRequest()
    const artifact = seal(failed)
    const grade = gradeMixedArtifacts({ ...request, verification: { B: null, C: { ...artifact, bytes: artifact.bytes + 1 } } })
    expect(grade.verification.B).toMatchObject({ status: 'invalid', error: 'missing', artifact: null, reported: null })
    expect(grade.verification.C).toMatchObject({ status: 'invalid', error: 'integrity', reported: null })
    expect(grade.pairStatus).toBe('invalid')
    expect(gradeMixedArtifacts({ ...request, policy: null }).data.policy.error).toBe('missing')
    const invalid = gradeMixedArtifacts({ ...request, cases: seal({ version: 1, cases: [] }),
      verification: { B: seal({ ...failed, score: 1 }), C: sealDataArtifact('{') } })
    expect(invalid.data.tests.error).toBe('schema')
    expect(invalid.verification.B.error).toBe('schema')
    expect(invalid.verification.C.error).toBe('json')
    expect(invalid.pairStatus).toBe('invalid')
  })

  it('does not treat QA agreement with an obsolete client as independent success', () => {
    const request = correctRequest()
    if (request.cases === null) throw new Error('Expected sealed QA fixture')
    const cases = parseCases(request.cases)
    const obsolete = { ...request.oracle.reference, maxRetries: 3 }
    const wrongCases = { ...cases, cases: cases.cases.map(item => ({ ...item, expected: executePayment(obsolete, item.input) })) }
    const grade = gradeMixedArtifacts({ ...request, policy: seal(obsolete), cases: seal(wrongCases) })
    expect(grade.data.policy.status).toBe('failed')
    expect(grade.data.tests.status).toBe('failed')
    expect(grade.pairStatus).toBe('failed')
  })

  it('retains parser error codes without accepting model self-assessment', () => {
    expect(() => parseMixedVerification(seal({ ...failed, score: 'passed' })))
      .toThrow(new DataArtifactError('schema'))
  })
})
