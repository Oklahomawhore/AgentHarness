/** Pure controlled calibration data derived from public policy and admitted message text, never parent grading references. */
import { z } from 'zod'
import { expandReportedGrants } from './reported-grant-evidence.mjs'
import type { PaymentInput, PaymentPolicy, PaymentTrace } from './data-artifacts.ts'

const record = z.record(z.string(), z.unknown())
const command = z.object({ kind: z.literal('command-observation'), version: z.literal(4),
  fields: z.object({ command: z.string(), rootIndex: z.number().int().nonnegative() }),
  state: z.literal('completed'), exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  timedOut: z.boolean(), aborted: z.boolean() })

function frame(text: string, tag: string): unknown {
  const body = text.split(`<${tag}>\n`)[1]?.split(`\n</${tag}>`)[0]
  if (body === undefined) throw new Error(`Missing actual ${tag} frame`)
  return JSON.parse(body) as unknown
}

/** Decode only current admitted policy text and typed completed command evidence, never historical coverage references.
 * @param texts - Text content extracted from the actual ordinary request; metadata is excluded.
 * @returns Visible policy fragments and command exit status; null does not invent an omitted outcome.
 */
export function mixedCalibrationEvidence(texts: readonly string[]) {
  const policy: string[] = []
  const commands: z.infer<typeof command>[] = []
  const observe = (value: unknown) => {
    const result = command.safeParse(value)
    if (result.success && result.data.fields.command === 'node verify.cjs' && result.data.fields.rootIndex === 0
      && result.data.signal === null && !result.data.timedOut && !result.data.aborted) commands.push(result.data)
  }
  for (const text of texts) {
    if (!text.includes('<shared-work-updates>') && !text.includes('<development-task-context>')) continue
    if (text.includes('<shared-work-updates>')) {
      const body = z.object({ updates: z.array(z.object({ sources: z.array(z.object({ quote: z.string() })) })),
        mandatory: z.array(z.unknown()) }).parse(frame(text, 'shared-work-updates'))
      for (const update of body.updates) for (const source of update.sources) policy.push(source.quote)
      for (const item of body.mandatory) {
        const value = record.parse(item)
        if (value.kind !== 'command-evidence') continue
        const publication = record.parse(value.publication)
        observe(publication.localToolObservation ?? publication.peerToolObservation)
      }
    } else {
      const raw = record.parse(frame(text, 'development-task-context'))
      const revision = Object.hasOwn(raw, 'observationReferences') ? '5' : '4'
      const body = z.object({ publications: z.array(record) }).parse(expandReportedGrants(raw, revision))
      for (const publication of body.publications) {
        if (publication.kind === 'reported-file') {
          const file = z.object({ path: z.string() }).parse(publication.file)
          if (file.path === 'policy.md') policy.push(z.string().parse(publication.content))
          continue
        }
        const text = z.string().parse(publication.text)
        const start = text.indexOf('\n{')
        if (start === -1) continue
        const observation = record.parse(JSON.parse(text.slice(start + 1)) as unknown)
        observe(observation)
        if (observation.kind !== 'tool-observation' || observation.reportedStatus !== 'success') continue
        const fields = record.parse(observation.fields)
        if (fields.path !== 'policy.md') continue
        if (observation.tool === 'Write') policy.push(z.string().parse(fields.content))
        if (observation.tool === 'Edit') policy.push(z.string().parse(fields.newString))
      }
    }
  }
  if (commands.length > 1) throw new Error('Controlled artifact decoder requires one current admitted command')
  return { policy, exitCode: commands[0]?.exitCode ?? null }
}

// This small public-contract implementation is independent of the hidden grader's executePayment interpreter.
function expectedTrace(policy: PaymentPolicy, input: PaymentInput): PaymentTrace {
  const body = input.body
  if (body === null || policy.requiredFields.some(field => !Object.hasOwn(body, field) || body[field] === null || body[field] === '')) {
    return { requests: [], outcome: { kind: 'error', code: 'CONTRACT_INVALID_PAYLOAD' } }
  }
  const requests = []
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    requests.push({ ...body })
    const outcome = input.responses[Math.min(attempt, input.responses.length - 1)]
    if (outcome === undefined) throw new Error('Public response sequence missing')
    if (outcome.kind === 'accepted' || outcome.code !== 'NETWORK_TIMEOUT' || attempt === policy.maxRetries) {
      return { requests, outcome }
    }
  }
  throw new Error('Public retry limit must terminate')
}

/** Produce a bounded public test set without accessing registered hidden inputs or mutants.
 * @param policy - Public baseline with changes derived from admitted policy text.
 * @returns Public cases with independent complete expected traces.
 */
export function mixedPublicCases(policy: PaymentPolicy) {
  const body = Object.fromEntries(policy.requiredFields.map(field => [field, `public-${field}`]))
  const fullBody = { ...body, extra: 'keep-this-field' }
  const inputs: PaymentInput[] = [
    { body: fullBody, responses: [{ kind: 'accepted' }] },
    { body: null, responses: [{ kind: 'accepted' }] },
    ...policy.requiredFields.map(field => ({ body: Object.fromEntries(Object.entries(fullBody).filter(([key]) => key !== field)),
      responses: [{ kind: 'accepted' as const }] })),
    ...['NETWORK_TIMEOUT', 'PAYMENT_DECLINED', 'RATE_LIMITED', 'UNKNOWN_PUBLIC_ERROR'].map(code => ({
      body: fullBody, responses: [{ kind: 'error' as const, code }],
    })),
    { body: fullBody, responses: [{ kind: 'error', code: 'NETWORK_TIMEOUT' }, { kind: 'accepted' }] },
    { body: fullBody, responses: [{ kind: 'error', code: 'NETWORK_TIMEOUT' },
      { kind: 'error', code: 'NETWORK_TIMEOUT' }, { kind: 'accepted' }] },
  ]
  return { version: 1, cases: inputs.map((input, index) => ({
    id: `public-derived-${index}`, input, expected: expectedTrace(policy, input),
  })) }
}

/** Quote authorized policy reports for transport calibration, without asserting summary quality.
 * @param sources - Actual provider-visible source bodies and attribution.
 * @returns Controlled valid relevance decisions and quoted updates.
 */
export function mixedCalibrationSummary(sources: readonly {
  readonly sourceId: string
  readonly body: string
  readonly attribution: unknown
}[]) {
  const relevant = sources.filter(({ attribution }) => {
    const parsed = record.safeParse(attribution)
    return parsed.success && parsed.data.path === 'policy.md'
  })
  return { version: 1,
    decisions: sources.map(source => ({ sourceId: source.sourceId, relevant: relevant.includes(source) })),
    updates: relevant.map((source) => {
      const correction = source.body.match(/maxRetries: (\d+)/g)?.at(-1)
      const attribution = record.safeParse(source.attribution)
      const isEdit = attribution.success && attribution.data.tool === 'Edit'
      const quote = isEdit && correction !== undefined ? correction
        : 'Retry only NETWORK_TIMEOUT. Never retry PAYMENT_DECLINED or unknown external errors. '
          + 'Preserve the complete original body on each attempt.'
      if (!source.body.includes(quote)) throw new Error('Controlled summary quote must occur in its actual source')
      return { text: isEdit ? 'Apply the reported retry correction.'
        : 'Preserve required fields, complete request bodies, and non-retry behavior from the reported policy.',
      sources: [{ sourceId: source.sourceId, quote }] }
    }) }
}
