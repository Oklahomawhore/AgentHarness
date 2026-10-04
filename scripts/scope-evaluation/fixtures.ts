/** Registered, controlled client/test programs for the five offline artifact-oracle cases. */
import { createHash } from 'node:crypto'

/** One externally checked submit call. Undefined payload means an absent HTTP body. */
export interface ArtifactCheck {
  readonly id: string
  readonly payload: Readonly<Record<string, unknown>> | undefined
  readonly expectedError: 'CONTRACT_INVALID_PAYLOAD' | 'CONTRACT_UNRESOLVED' | 'CONTRACT_UNAVAILABLE' | null
}

/** Frozen data and reviewed programs; this object is not a model trial or an execution permit for arbitrary code. */
export interface CaseFixture {
  readonly id: 'F1' | 'F2' | 'F3' | 'F4' | 'F5'
  readonly seed: number
  readonly operation: { readonly method: 'POST'; readonly path: '/orders'; readonly operationId: string }
  readonly mappedFields: {
    readonly old: string
    readonly intermediate: string
    readonly final: string
    readonly quantity: string
    readonly proposal: string
  }
  readonly sourceRefs: readonly string[]
  readonly timeline: readonly { readonly kind: 'write' | 'end'; readonly source: string; readonly document: string | null; readonly note: string }[]
  readonly initialClientSource: string
  readonly correctClientSource: string
  readonly correctTestSource: string
  readonly mutants: readonly { readonly id: string; readonly clientSource: string }[]
  readonly clientControls: Readonly<Record<'constant-success' | 'literal-sku' | 'hang' | 'syntax-error' | 'early-disconnect', string>>
  readonly testControls: Readonly<Record<'always-pass' | 'always-fail' | 'string-only' | 'empty' | 'hang' | 'syntax-error' | 'oracle-read' | 'path-fingerprint', string>>
  readonly checks: readonly ArtifactCheck[]
  readonly requiredFields: readonly string[]
  readonly bodyRequired: boolean
  readonly expectedVerdict: { readonly status: 'blocked'; readonly reason: 'conflict' | 'source-withdrawn'; readonly sources: readonly string[] } | null
}

const registered = new WeakMap<CaseFixture, { clients: ReadonlySet<string>; tests: ReadonlySet<string> }>()

function digest(seed: number, label: string): string {
  return createHash('sha256').update(`${seed}:${label}`).digest('hex').slice(0, 12)
}

function client(required: readonly string[], bodyRequired: boolean, blocked: string | null = null): string {
  return `import { request } from './transport.mjs'
export async function submit(payload) {
  ${blocked === null ? '' : `throw Object.assign(new Error(${JSON.stringify(blocked)}), { code: ${JSON.stringify(blocked)} })`}
  const required = ${JSON.stringify(required)}
  if (payload === undefined) {
    ${bodyRequired ? "throw Object.assign(new Error('body required'), { code: 'CONTRACT_INVALID_PAYLOAD' })" : "return request({ method: 'POST', path: '/orders', hasBody: false, body: null })"}
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || required.some(key => !Object.hasOwn(payload, key))) {
    throw Object.assign(new Error('required field absent'), { code: 'CONTRACT_INVALID_PAYLOAD' })
  }
  return request({ method: 'POST', path: '/orders', hasBody: true, body: payload })
}
`
}

function document(required: readonly string[], bodyRequired: boolean, operationId: string, description = ''): string {
  return `${JSON.stringify({ openapi: '3.1.0', info: { title: 'Orders', version: '1' }, paths: {
    '/orders': { post: { operationId, description, requestBody: { required: bodyRequired, content: { 'application/json': {
      schema: { type: 'object', properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])), required },
    } } }, responses: { '201': { description: 'Accepted' } } } },
  } })}\n`
}

function testProgram(checks: readonly ArtifactCheck[], verdict: CaseFixture['expectedVerdict']): string {
  return `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { submit, resetRequests, requests } from '../frontend/client.mjs'
${checks.map((check, index) => `test(${JSON.stringify(`behavior ${index + 1}`)}, async () => {
  await resetRequests()
  const payload = ${check.payload === undefined ? 'undefined' : JSON.stringify(check.payload)}
  ${check.expectedError === null ? `let result
  await assert.doesNotReject(async () => { result = await submit(payload) })
  assert.equal(result.accepted, true)
  assert.deepEqual(await requests(), [{ method: 'POST', path: '/orders', hasBody: payload !== undefined, body: payload === undefined ? null : payload }])` : `await assert.rejects(submit(payload), { code: ${JSON.stringify(check.expectedError)} })
  assert.deepEqual(await requests(), [])`}
})`).join('\n')}
${verdict === null ? '' : `test('record blocked evidence', async () => {
  await writeFile(new URL('./verdict.json', import.meta.url), ${JSON.stringify(`${JSON.stringify(verdict)}\n`)})
})`}
`
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Build deterministic reviewed fixtures, including held-out client inputs distinct from QA's example values.
 * @param seed Nonnegative safe integer retained in the run manifest.
 * @returns Five immutable registry-owned cases. Reconstructing their JSON does not confer execution permission.
 */
export function createFixtures(seed: number): readonly CaseFixture[] {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('fixture seed must be a nonnegative safe integer')
  const fields = {
    old: `field_${digest(seed, 'old')}`, intermediate: `field_${digest(seed, 'intermediate')}`,
    final: `field_${digest(seed, 'final')}`, quantity: `field_${digest(seed, 'quantity')}`, proposal: `field_${digest(seed, 'proposal')}`,
  }
  return (['F1', 'F2', 'F3', 'F4', 'F5'] as const).map((id) => {
    const operationId = `operation_${digest(seed, `${id}:operation`)}`
    const primarySource = 'authorized-source-a'
    const secondarySource = 'authorized-source-b'
    const sourceRefs = id === 'F3' ? [primarySource, secondarySource] : [primarySource]
    const initialClientSource = client([fields.old], true)
    const requiredField = id === 'F1' || id === 'F4' ? fields.final : fields.old
    const requiredFields = [requiredField]
    const bodyRequired = id !== 'F2'
    const blocked = id === 'F3' ? 'CONTRACT_UNRESOLVED' : id === 'F5' ? 'CONTRACT_UNAVAILABLE' : null
    const correctClientSource = client(requiredFields, bodyRequired, blocked)
    const expectedVerdict: CaseFixture['expectedVerdict'] = blocked === null ? null : {
      status: 'blocked', reason: id === 'F3' ? 'conflict' : 'source-withdrawn', sources: sourceRefs,
    }
    const makeChecks = (domain: string): ArtifactCheck[] => {
      const value = `${domain}-${digest(seed, `${id}:${domain}`)}-雪`
      const inputs: (Readonly<Record<string, unknown>> | undefined)[] = [undefined, {},
        { [fields.old]: value }, { [fields.final]: value, note: `unchanged-${value}` },
        { [fields.old]: value, [fields.quantity]: '2' }, { [fields.intermediate]: value }, { [fields.proposal]: value }]
      if (domain === 'held-out') inputs.push({ [requiredField]: `${value}-second`, note: '' })
      return inputs.map((payload, index) => ({ id: `${domain}-${index + 1}`, payload,
        expectedError: blocked ?? (payload === undefined ? bodyRequired ? 'CONTRACT_INVALID_PAYLOAD' : null
          : requiredFields.every(key => Object.hasOwn(payload, key)) ? null : 'CONTRACT_INVALID_PAYLOAD'),
      }))
    }
    const mutants: CaseFixture['mutants'] = id === 'F1' ? [{ id: 'old-field', clientSource: initialClientSource }]
      : id === 'F2' ? [{ id: 'force-body', clientSource: client([fields.old], true) }, { id: 'all-fields-optional', clientSource: client([], false) }]
        : id === 'F3' ? [{ id: 'choose-left', clientSource: client([fields.old], true) }, { id: 'choose-right', clientSource: client([fields.old, fields.quantity], true) }]
          : id === 'F4' ? [{ id: 'old-field', clientSource: initialClientSource }, { id: 'intermediate-field', clientSource: client([fields.intermediate], true) }]
            : [{ id: 'stale-active', clientSource: initialClientSource }]
    const timeline: { kind: 'write' | 'end'; source: string; document: string | null; note: string }[] = [
      { kind: 'write', source: primarySource, document: document([fields.old], true, operationId), note: 'initial approved source' },
    ]
    if (id === 'F4') {
      timeline.push({ kind: 'write', source: primarySource, document: document([fields.intermediate], true, operationId), note: 'intermediate correction' })
      for (let index = 0; index < 12; index++) timeline.push({ kind: 'write', source: primarySource,
        document: document([fields.intermediate], true, operationId, `${index}:`.padEnd(512, 'x')), note: 'authorized description-only update; selected facts unchanged' })
    }
    timeline.push(id === 'F5' ? { kind: 'end', source: primarySource, document: null, note: 'owner terminal commit' }
      : { kind: 'write', source: id === 'F3' ? secondarySource : primarySource, document: document(id === 'F3' ? [fields.old, fields.quantity] : requiredFields, bodyRequired, operationId), note: 'final authorized observation' })
    const testControls = {
      'always-pass': "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('constant', () => assert.equal(true, true))\n",
      'always-fail': "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('constant', () => assert.fail('constant failure'))\n",
      'string-only': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; test('source string', async () => assert.match(await readFile(new URL('../frontend/client.mjs', import.meta.url), 'utf8'), /submit/))\n",
      'path-fingerprint': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { submit } from '../frontend/client.mjs'; test('path fingerprint', async () => { await submit(undefined).catch(() => undefined); if (/variant-/.test(import.meta.url) || /variant-/.test(process.cwd())) assert.fail('recognized mutant directory') })\n",
      empty: 'export const nothing = true\n',
      hang: "import { test } from 'node:test'; test('never settles', async () => new Promise(() => { setInterval(() => {}, 1000) }))\n",
      'syntax-error': 'export const =\n',
      'oracle-read': "import { test } from 'node:test'; import { readFile } from 'node:fs/promises'; test('read hidden oracle', async () => readFile(new URL('../../../private/oracle.json', import.meta.url), 'utf8'))\n",
    }
    const fixture: CaseFixture = deepFreeze({ id, seed, operation: { method: 'POST', path: '/orders', operationId },
      mappedFields: fields, sourceRefs, timeline, initialClientSource, correctClientSource,
      correctTestSource: testProgram(makeChecks('qa-example'), expectedVerdict), mutants,
      clientControls: {
        'constant-success': 'export async function submit() { return { accepted: true } }\n',
        'literal-sku': client(['sku'], true), hang: 'export async function submit() { process.stdout.write("controlled-hang\\n"); return new Promise(() => { setInterval(() => {}, 1000) }) }\n',
        'early-disconnect': 'export async function submit() { process.disconnect(); return { accepted: true } }\n',
        'syntax-error': 'export const =\n',
      }, testControls, checks: makeChecks('held-out'), requiredFields, bodyRequired, expectedVerdict })
    registered.set(fixture, {
      clients: new Set([initialClientSource, correctClientSource,
        ...mutants.map(m => m.clientSource), ...Object.values(fixture.clientControls)]),
      tests: new Set([fixture.correctTestSource, ...Object.values(testControls)]) })
    return fixture
  })
}

/** Reject sources outside the reviewed fixture registry before creating files or processes.
 * @param fixture Original immutable object from createFixtures.
 * @param clientSource Exact reviewed client source.
 * @param testSource Exact reviewed test source.
 * @returns Nothing; throws for arbitrary, mutated, or deserialized inputs.
 */
export function assertControlledSources(fixture: CaseFixture, clientSource: string, testSource: string): void {
  const permitted = registered.get(fixture)
  if (!permitted?.clients.has(clientSource) || !permitted.tests.has(testSource)) {
    throw new Error('Only registered controlled fixture sources may execute; unreviewed model artifacts require OS isolation')
  }
}
