import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  executePayment, gradeDataArtifacts, parseCases, parsePolicy, paymentCasesJsonSchema, paymentPolicyJsonSchema,
  sealDataArtifact, type PaymentCases, type PaymentInput, type PaymentPolicy, type PaymentResponse,
} from './data-artifacts.ts'

const reference: PaymentPolicy = {
  version: 1, requiredFields: ['token'], maxRetries: 1, retryableErrors: ['NETWORK_TIMEOUT'],
}
const body = { token: 'approved-token', amount: 42, active: false, note: null }
const accepted: PaymentResponse = { kind: 'accepted' }
const timeout: PaymentResponse = { kind: 'error', code: 'NETWORK_TIMEOUT' }
const declined: PaymentResponse = { kind: 'error', code: 'PAYMENT_DECLINED' }
const rateLimited: PaymentResponse = { kind: 'error', code: 'RATE_LIMITED' }
const invalid: PaymentResponse = { kind: 'error', code: 'CONTRACT_INVALID_PAYLOAD' }
const unknown: PaymentResponse = { kind: 'error', code: 'UNKNOWN_EXTERNAL_ERROR' }
const goodCases: PaymentCases = { version: 1, cases: [
  { id: 'accepted', input: { body, responses: [accepted] }, expected: { requests: [body], outcome: accepted } },
  { id: 'missing', input: { body: {}, responses: [accepted] }, expected: { requests: [], outcome: invalid } },
  { id: 'null', input: { body: null, responses: [accepted] }, expected: { requests: [], outcome: invalid } },
  { id: 'retry-success', input: { body, responses: [timeout, accepted] },
    expected: { requests: [body, body], outcome: accepted } },
  { id: 'retry-exhausted', input: { body, responses: [timeout] },
    expected: { requests: [body, body], outcome: timeout } },
  { id: 'declined', input: { body, responses: [declined, accepted] }, expected: { requests: [body], outcome: declined } },
  { id: 'rate-limit', input: { body, responses: [rateLimited, accepted] },
    expected: { requests: [body], outcome: rateLimited } },
  { id: 'unknown', input: { body, responses: [unknown, accepted] }, expected: { requests: [body], outcome: unknown } },
] }
const mutants = [
  { id: 'old-three', policy: { ...reference, maxRetries: 3 } },
  { id: 'failed-nine', policy: { ...reference, maxRetries: 9 } },
  { id: 'no-retry', policy: { ...reference, maxRetries: 0 } },
  { id: 'decline-retry', policy: { ...reference, retryableErrors: ['NETWORK_TIMEOUT', 'PAYMENT_DECLINED'] } },
  { id: 'rate-retry', policy: { ...reference, retryableErrors: ['NETWORK_TIMEOUT', 'RATE_LIMITED'] } },
] satisfies readonly { id: string; policy: PaymentPolicy }[]
const hiddenInputs = goodCases.cases.map(item => item.input)
const seal = (value: unknown) => sealDataArtifact(JSON.stringify(value))
const grade = (policy: unknown, cases: unknown) => gradeDataArtifacts({
  policy: seal(policy), cases: seal(cases), reference, hiddenInputs, mutants,
})

describe('sealed data artifact parsing', () => {
  it('retains exact UTF-8 bytes and distinguishes formatting without changing parsed policy', () => {
    const compact = JSON.stringify(reference)
    const formatted = '\n' + JSON.stringify(reference, null, 2) + '\n'
    const artifact = sealDataArtifact(formatted)
    expect(artifact).toEqual({ text: formatted, bytes: Buffer.byteLength(formatted),
      sha256: createHash('sha256').update(formatted, 'utf8').digest('hex') })
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(artifact.sha256).not.toBe(sealDataArtifact(compact).sha256)
    expect(parsePolicy(artifact)).toEqual(parsePolicy(sealDataArtifact(compact)))
    const unicode = sealDataArtifact('汉字🙂')
    expect(unicode.bytes).toBe(10)
    expect(unicode.sha256).toBe(createHash('sha256').update(Buffer.from('汉字🙂')).digest('hex'))
    expect(() => sealDataArtifact('\ud800')).toThrow('invalid-utf8')
  })

  it('rejects changed byte receipts, invalid JSON, and complete oversized artifacts without trimming', () => {
    const artifact = seal(reference)
    expect(() => parsePolicy({ ...artifact, bytes: artifact.bytes + 1 })).toThrow('integrity')
    expect(() => parsePolicy({ ...artifact, sha256: '0'.repeat(64) })).toThrow('integrity')
    expect(() => parsePolicy(sealDataArtifact('not-json\n{}'))).toThrow('json')
    const exact = sealDataArtifact(artifact.text + ' '.repeat(65_536 - artifact.bytes))
    expect(parsePolicy(exact)).toEqual(reference)
    const oversized = sealDataArtifact(exact.text + '字')
    expect(oversized.bytes).toBe(65_539)
    expect(() => parsePolicy(oversized)).toThrow('byte-limit')
  })

  it.each([
    { ...reference, pass: true },
    { ...reference, execute: 'process.exit(0)' },
    { ...reference, requiredFields: [] },
    { ...reference, requiredFields: ['one', 'two', 'three', 'four', 'five'] },
    { ...reference, requiredFields: ['token', 'token'] },
    { ...reference, maxRetries: -1 },
    { ...reference, maxRetries: 11 },
    { ...reference, maxRetries: 1.5 },
    { ...reference, maxRetries: Number.MAX_SAFE_INTEGER + 1 },
    { ...reference, retryableErrors: ['UNKNOWN_EXTERNAL_ERROR'] },
    { ...reference, retryableErrors: ['NETWORK_TIMEOUT', 'NETWORK_TIMEOUT'] },
    { ...reference, requiredFields: ['token.path'] },
  ])('rejects invalid policy data %#', (policy) => {
    expect(() => parsePolicy(seal(policy))).toThrow('schema')
  })

  it('accepts bounded but behaviorally wrong policies, instead of embedding the correct business policy in validation', () => {
    expect(parsePolicy(seal({ ...reference, maxRetries: 10,
      requiredFields: ['a', 'b', 'c', 'd'], retryableErrors: ['PAYMENT_DECLINED', 'RATE_LIMITED'] })))
      .toMatchObject({ maxRetries: 10, retryableErrors: ['PAYMENT_DECLINED', 'RATE_LIMITED'] })
    expect(parsePolicy(seal({ ...reference, maxRetries: 0, retryableErrors: [] }))).toMatchObject({ maxRetries: 0 })
  })

  it('rejects empty, duplicated, incomplete, executable and self-scored QA submissions', () => {
    const item = goodCases.cases[0]
    expect(item).toBeDefined()
    for (const value of [
      { version: 1, cases: [] }, { version: 1, cases: [item, item] },
      { version: 1, cases: Array.from({ length: 33 }, (_, index) => ({ ...item, id: 'case_' + String(index) })) },
      { version: 1, cases: [{ id: 'self-score', pass: true }] },
      { version: 1, cases: [{ ...item, expected: { outcome: accepted } }] },
      { version: 1, cases: [{ ...item, expected: { requests: [], outcome: accepted, passed: true } }] },
      { version: 1, cases: [{ ...item, input: { body, responses: [], code: 'return true' } }] },
    ]) expect(() => parseCases(seal(value))).toThrow('schema')
  })

  it('bounds scalar data, input scripts, full traces, field counts, and Unicode code points', () => {
    const one = (input: unknown, expected: unknown = { requests: [], outcome: accepted }) =>
      seal({ version: 1, cases: [{ id: 'bounded', input, expected }] })
    const validBody = { token: '🙂'.repeat(256), min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER, zero: 0, flag: false, nil: null }
    expect(parseCases(one({ body: validBody, responses: Array.from({ length: 12 }, () => timeout) })).cases[0]?.input.body)
      .toEqual(validBody)
    for (const input of [
      { body: { token: '🙂'.repeat(257) }, responses: [accepted] },
      { body: { token: 0.5 }, responses: [accepted] },
      { body: { token: 9_007_199_254_740_992 }, responses: [accepted] },
      { body: { token: { nested: true } }, responses: [accepted] },
      { body: { token: [] }, responses: [accepted] },
      { body: Object.fromEntries(Array.from({ length: 17 }, (_, index) => ['key_' + String(index), 'value'])), responses: [accepted] },
      { body, responses: [] }, { body, responses: Array.from({ length: 13 }, () => accepted) },
      { body, responses: [{ kind: 'error', code: 'x'.repeat(65) }] },
      { body, responses: [{ kind: 'accepted', code: 'ignored' }] },
    ]) expect(() => parseCases(one(input))).toThrow('schema')
    expect(() => parseCases(one({ body, responses: [accepted] },
      { requests: Array.from({ length: 12 }, () => body), outcome: accepted }))).toThrow('schema')
  })

  it('rejects prototype-named body fields instead of silently dropping original request data', () => {
    const text = '{"version":1,"cases":[{"id":"prototype","input":{"body":{"token":"ok","__proto__":"keep"},'
      + '"responses":[{"kind":"accepted"}]},"expected":{"requests":[],"outcome":{"kind":"accepted"}}}]}'
    expect(() => parseCases(sealDataArtifact(text))).toThrow('schema')
    expect(() => parsePolicy(seal({ ...reference, requiredFields: ['__proto__'] }))).toThrow('schema')
  })

  it('publishes closed schemas with protocol bounds but no private correct answer', () => {
    expect(paymentPolicyJsonSchema).toMatchObject({ additionalProperties: false, properties: {
      maxRetries: { minimum: 0, maximum: 10 },
      requiredFields: { minItems: 1, maxItems: 4, uniqueItems: true },
    } })
    expect(paymentCasesJsonSchema).toMatchObject({ additionalProperties: false, properties: {
      cases: { minItems: 1, maxItems: 32, items: { additionalProperties: false } },
    } })
    const schemaText = JSON.stringify(paymentCasesJsonSchema)
    expect(schemaText).toContain('"maxLength":256')
    expect(schemaText).toContain('"maxProperties":16')
    expect(schemaText).not.toContain(body.token)
  })
})

describe('fixed payment behavior', () => {
  it.each([null, {}, { token: null }, { token: '' }])('rejects missing or empty required values: %j', (inputBody) => {
    expect(executePayment(reference, { body: inputBody, responses: [accepted] })).toEqual({ requests: [], outcome: invalid })
  })

  it('accepts zero and false, and returns detached complete bodies on every retry', () => {
    for (const token of [0, false]) {
      const input: PaymentInput = { body: { ...body, token }, responses: [timeout, accepted] }
      const trace = executePayment(reference, input)
      expect(trace).toEqual({ requests: [input.body, input.body], outcome: accepted })
      expect(trace.requests[0]).not.toBe(input.body)
      expect(trace.requests[0]).not.toBe(trace.requests[1])
      expect(trace.outcome).not.toBe(accepted)
    }
  })

  it('counts retries after the first request and repeats only the final scripted response', () => {
    expect(executePayment({ ...reference, maxRetries: 0 }, { body, responses: [timeout, accepted] }))
      .toEqual({ requests: [body], outcome: timeout })
    expect(executePayment({ ...reference, maxRetries: 10 }, { body, responses: [timeout] }))
      .toEqual({ requests: Array.from({ length: 11 }, () => body), outcome: timeout })
    expect(executePayment({ ...reference, maxRetries: 10 }, { body, responses: [accepted, timeout] }))
      .toEqual({ requests: [body], outcome: accepted })
  })

  it('never retries unknown external errors and terminates nonconfigured known errors', () => {
    const all: PaymentPolicy = { ...reference, maxRetries: 10,
      retryableErrors: ['NETWORK_TIMEOUT', 'PAYMENT_DECLINED', 'RATE_LIMITED'] }
    expect(executePayment(all, { body, responses: [unknown, accepted] }))
      .toEqual({ requests: [body], outcome: unknown })
    expect(executePayment(reference, { body, responses: [declined, accepted] }))
      .toEqual({ requests: [body], outcome: declined })
    expect(executePayment(all, { body, responses: [rateLimited, accepted] }))
      .toEqual({ requests: [body, body], outcome: accepted })
  })
})

describe('independent grading after artifact sealing', () => {
  it('passes independently authored complete traces and checks every registered mutant', () => {
    const result = grade(reference, goodCases)
    expect(result.pairStatus).toBe('passed')
    expect(result.policy.status).toBe('passed')
    expect(result.policy.checks).toHaveLength(hiddenInputs.length)
    expect(result.tests.referenceChecks.every(check => check.passed)).toBe(true)
    expect(result.tests.mutants).toHaveLength(mutants.length)
    expect(result.tests.mutants.every(mutant => mutant.killed && mutant.detectedBy.length > 0)).toBe(true)
    expect(result.policy.artifact).toEqual({ sha256: seal(reference).sha256, bytes: seal(reference).bytes })
  })

  it.each(mutants)('fails valid but incorrect policy $id without changing the QA verdict', ({ policy }) => {
    const result = grade(policy, goodCases)
    expect(result.policy.status).toBe('failed')
    expect(result.policy.checks.some(check => !check.passed)).toBe(true)
    expect(result.tests.status).toBe('passed')
    expect(result.pairStatus).toBe('failed')
  })

  it('reports missing or malformed B independently from valid C', () => {
    const missing = gradeDataArtifacts({ policy: null, cases: seal(goodCases), reference, hiddenInputs, mutants })
    expect(missing.policy).toMatchObject({ status: 'invalid', error: 'missing', artifact: null, checks: [] })
    expect(missing.tests.status).toBe('passed')
    const forged = grade({ ...reference, passed: true }, goodCases)
    expect(forged.policy).toMatchObject({ status: 'invalid', error: 'schema' })
    expect(forged.tests.status).toBe('passed')
  })

  it('fails reference-valid but trivial QA that cannot distinguish any mutant', () => {
    const result = grade(reference, { version: 1, cases: goodCases.cases.slice(0, 1) })
    expect(result.policy.status).toBe('passed')
    expect(result.tests.status).toBe('failed')
    expect(result.tests.referenceChecks.every(check => check.passed)).toBe(true)
    expect(result.tests.mutants.every(mutant => !mutant.killed)).toBe(true)
  })

  it('never counts always-failing QA as useful mutant detection', () => {
    const result = grade(reference, { version: 1, cases: goodCases.cases.map(item => ({
      ...item, expected: { requests: [], outcome: { kind: 'error', code: 'SELF_REPORTED_FAILURE' } },
    })) })
    expect(result.policy.status).toBe('passed')
    expect(result.tests.status).toBe('failed')
    expect(result.tests.referenceChecks.every(check => !check.passed)).toBe(true)
    expect(result.tests.mutants.every(mutant => !mutant.killed && mutant.detectedBy.length > 0)).toBe(true)
  })

  it('marks empty QA invalid and preserves the correct policy grade', () => {
    const result = grade(reference, { version: 1, cases: [] })
    expect(result.policy.status).toBe('passed')
    expect(result.tests).toMatchObject({ status: 'invalid', error: 'schema', referenceChecks: [], mutants: [] })
    expect(result.pairStatus).toBe('invalid')
  })

  it('rejects vacuous or ambiguous fixture grading instead of reporting success', () => {
    const request = { policy: seal(reference), cases: seal(goodCases), reference, hiddenInputs, mutants }
    expect(() => gradeDataArtifacts({ ...request, hiddenInputs: [] })).toThrow('requires hidden inputs')
    expect(() => gradeDataArtifacts({ ...request, mutants: [] })).toThrow('requires hidden inputs')
    expect(() => gradeDataArtifacts({ ...request, mutants: [...mutants, ...mutants] })).toThrow('distinct named mutants')
  })
})
