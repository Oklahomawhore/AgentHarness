/** Frozen public projects and separate parent-owned grading data for ordinary Agent configuration work. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { executePayment, paymentCasesJsonSchema, paymentPolicyJsonSchema,
  type PaymentCases, type PaymentInput, type PaymentPolicy } from './data-artifacts.ts'

/** One explicitly selected model route and its finite per-role or per-owner limits. */
export interface DataModelRoute {
  readonly provider: 'deepseek-official'
  readonly model: string
  readonly endpoint: string
  readonly apiKeyEnv: string
  readonly credentialsPath: string | null
  readonly maxCalls: number
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly maxOutputBytes: number
  readonly timeoutMs: number
}

/** Public file access and task for one independently running receiving Session. */
export interface DataRoleProject {
  readonly goal: string
  readonly initialFiles: Readonly<Record<string, string>>
  readonly readableFiles: readonly string[]
  readonly writableFiles: readonly string[]
  readonly artifactPath: string
  readonly publicPolicyPath: string
  readonly publicCasesPath: string
}

/** Exact runtime input; private grading cases and expected artifacts are excluded. */
export interface NativeDataStudy {
  readonly version: 1
  readonly id: 'payment-json-work-v1'
  readonly seed: number
  readonly roles: Readonly<Record<'B' | 'C', DataRoleProject>>
  readonly source: {
    readonly path: 'policy.md'
    readonly initialContent: string
    readonly correction: { readonly oldString: string; readonly newString: string }
    readonly failedEdit: { readonly oldString: string; readonly newString: string }
    readonly expectedContent: string
  }
  readonly ordinary: DataModelRoute
  readonly semantic: DataModelRoute
  readonly limits: {
    readonly contextBytes: number
    readonly maxArtifactBytes: number
    readonly wallTimeoutMs: number
    readonly cleanupTimeoutMs: number
    readonly operationTimeoutMs: number
  }
}

/** Parent-only behavior references; never register these as a model tool or public project file. */
export interface DataStudyOracle {
  readonly reference: PaymentPolicy
  readonly hiddenInputs: readonly PaymentInput[]
  readonly mutants: readonly { readonly id: string; readonly policy: PaymentPolicy }[]
}

/** Registration configuration contains routes and limits but no credential values. */
export type DataStudyConfig = Pick<NativeDataStudy, 'ordinary' | 'semantic' | 'limits'>

/** Explicit frozen condition names; shared-summary S is not implemented in this study. */
export const dataStudyConditions = ['N', 'E', 'R'] as const

const routeSchema = z.object({
  provider: z.literal('deepseek-official'), model: z.string().min(1).max(128),
  endpoint: z.url(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  credentialsPath: z.string().refine(isAbsolute).nullable(),
  maxCalls: z.number().int().min(1).max(12), maxInputBytes: z.number().int().min(1024).max(262144),
  maxOutputTokens: z.number().int().min(128).max(4096), maxOutputBytes: z.number().int().min(1024).max(65536),
  timeoutMs: z.number().int().min(1000).max(120000),
}).strict()
const configurationSchema = z.object({ ordinary: routeSchema, semantic: routeSchema,
  limits: z.object({ contextBytes: z.number().int().min(2048).max(32768),
    maxArtifactBytes: z.number().int().min(1024).max(65536),
    wallTimeoutMs: z.number().int().min(30000).max(1800000),
    cleanupTimeoutMs: z.number().int().min(1000).max(30000),
    operationTimeoutMs: z.number().int().min(1000).max(60000),
  }).strict(),
}).strict()

/** Parse explicit configuration without reading credentials or contacting a provider.
 * @param input - Untrusted registration JSON; unknown fields, including credential values, are rejected.
 * @param execution - Live uses the official endpoint; local calibration accepts only a loopback HTTP endpoint.
 * @returns Validated model routes and limits, detached from the input.
 */
export function parseDataStudyConfig(input: unknown, execution: 'live' | 'transport-calibration'): DataStudyConfig {
  const value = configurationSchema.parse(input)
  for (const route of [value.ordinary, value.semantic]) {
    if (execution === 'transport-calibration' && route.credentialsPath !== null) {
      throw new Error('transport calibration must not load credential files')
    }
    const url = new URL(route.endpoint)
    if (url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) {
      throw new Error('data study endpoint must contain no credentials, query, fragment, or unsupported path')
    }
    if (execution === 'live' ? url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port !== ''
      : url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.port === '') {
      throw new Error('data study endpoint does not match its registered execution provenance')
    }
  }
  if (value.semantic.maxCalls < 2) throw new Error('semantic maxCalls must cover both recipient responsibilities')
  return value
}

function json(value: unknown): string { return JSON.stringify(value, null, 2) + '\n' }

/** Build the same public projects and source trajectory for every registered condition.
 * @param seed - Nonnegative safe integer controlling public field aliases and private behavior inputs.
 * @param config - Explicit validated model routes and limits.
 * @returns Runtime-visible data and separate parent-only oracle, without starting any process or model call.
 */
export function createDataStudy(seed: number, config: DataStudyConfig): { runtime: NativeDataStudy; oracle: DataStudyOracle } {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('data study seed must be a nonnegative safe integer')
  const alias = createHash('sha256').update(`payment-json-public/${seed}`).digest('hex').slice(0, 8)
  const requiredFields = [`order_${alias}`, `account_${alias}`] as const
  const initial: PaymentPolicy = { version: 1, requiredFields, maxRetries: 3, retryableErrors: ['NETWORK_TIMEOUT'] }
  const reference: PaymentPolicy = { ...initial, maxRetries: 1 }
  const body = { [requiredFields[0]]: 'public-order', [requiredFields[1]]: 'public-account' }
  const publicInputs: PaymentInput[] = [
    { body, responses: [{ kind: 'accepted' }] },
    { body: null, responses: [{ kind: 'accepted' }] },
    { body, responses: [{ kind: 'error', code: 'PAYMENT_DECLINED' }, { kind: 'accepted' }] },
    { body, responses: [{ kind: 'error', code: 'UNRECOGNIZED_EXTERNAL_ERROR' }, { kind: 'accepted' }] },
  ]
  const publicCases: PaymentCases = { version: 1, cases: publicInputs.map((input, index) => ({
    id: `public-${index + 1}`, input, expected: executePayment(initial, input),
  })) }
  const instructions = `# Payment policy workspace

The payment executor accepts a flat JSON body and a bounded response sequence. Required fields must exist as own properties and must not be null or empty strings; zero and false are valid. Invalid bodies produce CONTRACT_INVALID_PAYLOAD with no request. Each attempt sends the original body unchanged. maxRetries counts retries after the first attempt; the last scripted response repeats after the script ends. Only known configured error codes may retry. Unknown external errors never retry. The JSON schemas define all accepted fields and limits.

The files under public/ are a frozen initial baseline, not a feed of current policy. evaluation_test executes this public baseline only. For QA, changed expectations can intentionally fail against that initial policy. Public diagnostics never contain hidden acceptance inputs or scores. Use current authorized shared reports when available; they describe reported work, not independently verified deployment. If no current evidence is available, do not invent a policy update.

Write only your assigned JSON artifact. Do not provide a self-reported score or executable code. The complete original bytes will be sealed after your Session finishes and checked independently.
`
  const base = { 'README.md': instructions, 'policy.schema.json': json(paymentPolicyJsonSchema),
    'cases.schema.json': json(paymentCasesJsonSchema), 'public/payment-policy.json': json(initial),
    'public/payment-cases.json': json(publicCases) }
  const project = (role: 'B' | 'C'): DataRoleProject => {
    const artifactPath = role === 'B' ? 'client/payment-policy.json' : 'qa/payment-cases.json'
    const initialFiles = { ...base, [artifactPath]: json(role === 'B' ? initial : publicCases) }
    return { goal: role === 'B'
      ? 'Maintain client/payment-policy.json for the payment client using the latest authorized policy reports. Read README.md and the schema, preserve unrelated behavior, write the configuration, and inspect public project diagnostics. Do not invent unavailable changes.'
      : 'Maintain qa/payment-cases.json with behavioral acceptance cases for the latest authorized payment policy. Read README.md and the schema. Include useful success, validation, retry and non-retry cases, with full expected request traces. The public policy is the frozen initial implementation; it may intentionally disagree with new requirements. Write the cases and inspect public diagnostics.',
    initialFiles, readableFiles: Object.keys(initialFiles), writableFiles: [artifactPath], artifactPath,
    publicPolicyPath: role === 'B' ? artifactPath : 'public/payment-policy.json',
    publicCasesPath: role === 'C' ? artifactPath : 'public/payment-cases.json' }
  }
  const initialContent = `# Payment client policy\n\nRequired body fields: ${requiredFields.join(', ')}.\nmaxRetries: 3\nRetry only NETWORK_TIMEOUT. Never retry PAYMENT_DECLINED or unknown external errors. Preserve the complete original body on each attempt.\n`
  const correction = { oldString: 'maxRetries: 3', newString: 'maxRetries: 1' }
  const privateAlias = createHash('sha256').update(`payment-json-hidden/${seed}`).digest('hex').slice(0, 12)
  const hiddenBody = { [requiredFields[0]]: `order-${privateAlias}`, [requiredFields[1]]: `account-${privateAlias}`, extra: 'preserve-me' }
  const hiddenInputs: PaymentInput[] = [
    { body: hiddenBody, responses: [{ kind: 'accepted' }] },
    { body: null, responses: [{ kind: 'accepted' }] },
    { body: { [requiredFields[0]]: 'missing-account' }, responses: [{ kind: 'accepted' }] },
    { body: { [requiredFields[1]]: 'missing-order' }, responses: [{ kind: 'accepted' }] },
    { body: hiddenBody, responses: [{ kind: 'error', code: 'NETWORK_TIMEOUT' }] },
    { body: hiddenBody, responses: [{ kind: 'error', code: 'NETWORK_TIMEOUT' }, { kind: 'accepted' }] },
    { body: hiddenBody, responses: [{ kind: 'error', code: 'NETWORK_TIMEOUT' }, { kind: 'error', code: 'NETWORK_TIMEOUT' }, { kind: 'accepted' }] },
    { body: hiddenBody, responses: [{ kind: 'error', code: 'PAYMENT_DECLINED' }, { kind: 'accepted' }] },
    { body: hiddenBody, responses: [{ kind: 'error', code: `UNKNOWN_${privateAlias}` }, { kind: 'accepted' }] },
    { body: hiddenBody, responses: [{ kind: 'error', code: 'RATE_LIMITED' }, { kind: 'accepted' }] },
  ]
  const mutants: DataStudyOracle['mutants'] = [
    { id: 'obsolete-three-retries', policy: initial },
    { id: 'failed-edit-nine-retries', policy: { ...reference, maxRetries: 9 } },
    { id: 'retries-disabled', policy: { ...reference, maxRetries: 0 } },
    { id: 'declines-retried', policy: { ...reference, retryableErrors: ['NETWORK_TIMEOUT', 'PAYMENT_DECLINED'] } },
    { id: 'rate-limits-retried', policy: { ...reference, retryableErrors: ['NETWORK_TIMEOUT', 'RATE_LIMITED'] } },
    { id: 'required-account-omitted', policy: { ...reference, requiredFields: [requiredFields[0]] } },
  ]
  return { runtime: { version: 1, id: 'payment-json-work-v1', seed, roles: { B: project('B'), C: project('C') },
    source: { path: 'policy.md', initialContent, correction,
      failedEdit: { oldString: 'maxRetries: 7', newString: 'maxRetries: 9' },
      expectedContent: initialContent.replace(correction.oldString, correction.newString) }, ...structuredClone(config) },
  oracle: { reference, hiddenInputs, mutants } }
}
