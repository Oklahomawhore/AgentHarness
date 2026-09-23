/** Read-only Volcengine TLS SearchLogs evidence provider for AgentHarness development rooms. */

import { createHash, createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  DevelopmentEvidenceItem,
  DevelopmentEvidenceItemId,
  DevelopmentEvidenceProvider,
  DevelopmentEvidenceProviderId,
  DevelopmentEvidenceProviderOutcome,
  DevelopmentEvidenceProviderQuery,
} from '@deepseek-ai/dsh-development-evidence'
import { z } from 'zod'

/** Cordis plugin identity shown in Loader diagnostics. */
export const name = 'agentharness-evidence-volcengine-tls'
/** Host services required by this provider. */
export const inject = ['credentials', 'developmentEvidence']

const SERVICE = 'TLS'
const API_VERSION = '0.3.0'
const SEARCH_PATH = '/SearchLogs'
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_SOURCE_QUERY_BYTES = 2048

const logSchema = z.record(z.string(), z.unknown())
const searchResponseSchema = z.object({
  ResultStatus: z.string(),
  Count: z.number().int().nonnegative().optional(),
  ListOver: z.boolean().optional(),
  ElapsedMillisecond: z.number().nonnegative().optional(),
  Logs: z.array(logSchema),
}).passthrough()
const errorResponseSchema = z.object({
  ResponseMetadata: z.object({
    Error: z.object({
      Code: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough()

/** TLS topic identity, access references, query window, and response resource policy. */
export interface Config {
  /** Unique lower-kebab identity registered with the evidence registry. */
  readonly providerId: string
  /** Operator-facing source label. */
  readonly label: string
  /** HTTPS origin of the Volcengine TLS regional endpoint. */
  readonly endpoint: string
  /** Volcengine region used by V4 request signing. */
  readonly region: string
  /** Exact TLS TopicId searched by this provider. */
  readonly topicId: string
  /** Credential reference containing the Volcengine access key. */
  readonly accessKeyRef: string
  /** Credential reference containing the Volcengine secret key. */
  readonly secretKeyRef: string
  /** Milliseconds searched backwards from each query time. */
  readonly lookbackMs: number
  /** TLS result order, `asc` or `desc`. */
  readonly sort: string
  /** Maximum UTF-8 bytes accepted in one TLS query expression. */
  readonly maxQueryBytes: number
  /** Maximum response-body bytes read before the result fails closed. */
  readonly maxResponseBytes: number
  /** Maximum UTF-8 bytes retained from one log record. */
  readonly maxSummaryBytes: number
}

/** Loader-visible TLS evidence provider configuration. */
export const Config: s<Config> = s.object({
  providerId: s.string().required(),
  label: s.string().required(),
  endpoint: s.string().required(),
  region: s.string().required(),
  topicId: s.string().required(),
  accessKeyRef: s.string().required(),
  secretKeyRef: s.string().required(),
  lookbackMs: s.number().step(1).min(1).required(),
  sort: s.string().required(),
  maxQueryBytes: s.number().step(1).min(1).max(MAX_SOURCE_QUERY_BYTES).required(),
  maxResponseBytes: s.number().step(1).min(1).required(),
  maxSummaryBytes: s.number().step(1).min(4).required(),
})

type SearchSort = 'asc' | 'desc'
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface ResolvedConfig extends Omit<Config, 'endpoint' | 'accessKeyRef' | 'secretKeyRef' | 'sort'> {
  readonly endpoint: URL
  readonly accessKeyRef: CredentialRef
  readonly secretKeyRef: CredentialRef
  readonly sort: SearchSort
}

interface SearchWindow {
  readonly start: number
  readonly end: number
}

class ResponseLimitError extends Error {}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`agentharness-volcengine-tls: ${field} must be a positive safe integer`)
  }
  return value
}

function utf8TextLimit(value: number, field: string): number {
  const normalized = positive(value, field)
  if (normalized < 4) throw new TypeError(`agentharness-volcengine-tls: ${field} must be at least 4 bytes`)
  return normalized
}

function text(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`agentharness-volcengine-tls: ${field} must not be blank`)
  return normalized
}

function credentialRef(value: string): CredentialRef {
  if (!CREDENTIAL_REF_PATTERN.test(value)) {
    throw new TypeError(`agentharness-volcengine-tls: credential reference "${value}" must match ${String(CREDENTIAL_REF_PATTERN)}`)
  }
  return value as CredentialRef
}

function endpoint(value: string): URL {
  const parsed = new URL(text(value, 'endpoint'))
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('agentharness-volcengine-tls: endpoint must be an HTTPS origin without credentials, path, query, or fragment')
  }
  return parsed
}

function sort(value: string): SearchSort {
  if (value === 'asc' || value === 'desc') return value
  throw new TypeError('agentharness-volcengine-tls: sort must be "asc" or "desc"')
}

function queryLimit(value: number): number {
  const normalized = positive(value, 'maxQueryBytes')
  if (normalized > MAX_SOURCE_QUERY_BYTES) {
    throw new TypeError(`agentharness-volcengine-tls: maxQueryBytes must not exceed ${MAX_SOURCE_QUERY_BYTES}`)
  }
  return normalized
}

function boundedText(value: string, maxBytes: number): string {
  const normalized = value.trim()
  let bytes = 0
  let result = ''
  for (const character of normalized) {
    const width = Buffer.byteLength(character, 'utf8')
    if (bytes + width > maxBytes) break
    result += character
    bytes += width
  }
  return result
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

function xDate(date: Date): { readonly long: string; readonly short: string } {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hour = pad(date.getUTCHours())
  const minute = pad(date.getUTCMinutes())
  const second = pad(date.getUTCSeconds())
  return { long: `${year}${month}${day}T${hour}${minute}${second}Z`, short: `${year}${month}${day}` }
}

function authorization(
  config: ResolvedConfig,
  accessKey: string,
  secretKey: string,
  body: string,
  date: Date,
): Headers {
  const contentType = 'application/json'
  const bodyHash = sha256(body)
  const formatted = xDate(date)
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${config.endpoint.host}`,
    `x-content-sha256:${bodyHash}`,
    `x-date:${formatted.long}`,
  ].join('\n')
  const canonicalRequest = ['POST', SEARCH_PATH, '', canonicalHeaders, '', signedHeaders, bodyHash].join('\n')
  const credentialScope = `${formatted.short}/${config.region}/${SERVICE}/request`
  const stringToSign = ['HMAC-SHA256', formatted.long, credentialScope, sha256(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(secretKey, formatted.short), config.region), SERVICE), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return new Headers({
    'Content-Type': contentType,
    'X-Content-Sha256': bodyHash,
    'X-Date': formatted.long,
    'X-Tls-Apiversion': API_VERSION,
    Authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  })
}

async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new ResponseLimitError('TLS SearchLogs response exceeded maxResponseBytes')
      chunks.push(next.value)
    }
  } catch (error) {
    try {
      await reader.cancel(error)
    } catch (_responseCancellationFailed) {
      // The original bounded-read failure remains authoritative.
    }
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]))
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function timestamp(record: Readonly<Record<string, unknown>>): string {
  const value = record.__time__
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return 'unknown-time'
}

function summary(record: Readonly<Record<string, unknown>>): string {
  const business = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !key.startsWith('__'))
    .sort(([left], [right]) => left.localeCompare(right)))
  if (Object.keys(business).length > 0) return stableJson(business)
  const content = record.__content__
  if (typeof content === 'string' && content.trim() !== '') return content
  return stableJson(record)
}

function errorCode(body: string): string | undefined {
  try {
    return errorResponseSchema.parse(JSON.parse(body)).ResponseMetadata?.Error?.Code
  } catch (_invalidTlsErrorBody) {
    // Error bodies are optional and untrusted; HTTP status remains sufficient.
    return undefined
  }
}

/** Read-only provider over one exact Volcengine TLS topic. */
export class VolcengineTlsEvidenceProvider implements DevelopmentEvidenceProvider {
  readonly id: DevelopmentEvidenceProviderId
  readonly label: string
  private readonly config: ResolvedConfig

  /**
   * Freeze endpoint, topic, credential references, and response bounds.
   * @param ctx - Host context providing credential resolution.
   * @param config - explicit topic, access references, time window, and resource policy.
   * @param fetcher - HTTPS implementation; defaults to the Host's native fetch.
   * @param now - query and signing clock; defaults to the current wall time.
   */
  constructor(
    private readonly ctx: Context,
    config: Config,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.id = text(config.providerId, 'providerId') as DevelopmentEvidenceProviderId
    this.label = text(config.label, 'label')
    this.config = Object.freeze({
      providerId: this.id,
      label: this.label,
      endpoint: endpoint(config.endpoint),
      region: text(config.region, 'region'),
      topicId: text(config.topicId, 'topicId'),
      accessKeyRef: credentialRef(config.accessKeyRef),
      secretKeyRef: credentialRef(config.secretKeyRef),
      lookbackMs: positive(config.lookbackMs, 'lookbackMs'),
      sort: sort(config.sort),
      maxQueryBytes: queryLimit(config.maxQueryBytes),
      maxResponseBytes: positive(config.maxResponseBytes, 'maxResponseBytes'),
      maxSummaryBytes: utf8TextLimit(config.maxSummaryBytes, 'maxSummaryBytes'),
    })
  }

  /**
   * Search one bounded time window without publishing logs to a room or Session.
   * @param request - TLS query expression and evidence-registry result bound.
   * @param signal - cancellation and registry timeout signal passed to fetch.
   * @returns source-attributed log citations or an explicit empty, denied, or failed outcome.
   */
  async query(
    request: DevelopmentEvidenceProviderQuery,
    signal: AbortSignal,
  ): Promise<DevelopmentEvidenceProviderOutcome> {
    if (Buffer.byteLength(request.query, 'utf8') > this.config.maxQueryBytes) {
      return { status: 'failed', reason: 'TLS query exceeds maxQueryBytes', retryable: false }
    }
    if (request.query.includes('|')) {
      return { status: 'failed', reason: 'TLS SQL analysis queries are not supported by this evidence provider', retryable: false }
    }
    const [accessKey, secretKey] = await Promise.all([
      this.ctx.credentials.resolve(this.config.accessKeyRef),
      this.ctx.credentials.resolve(this.config.secretKeyRef),
    ])
    if (accessKey === undefined || secretKey === undefined) {
      return { status: 'denied', reason: 'Volcengine TLS credentials are not configured' }
    }
    signal.throwIfAborted()
    const date = this.now()
    const window = { start: date.getTime() - this.config.lookbackMs, end: date.getTime() }
    const body = JSON.stringify({
      TopicId: this.config.topicId,
      Query: request.query,
      StartTime: window.start,
      EndTime: window.end,
      Limit: request.limit,
      Sort: this.config.sort,
    })
    try {
      const response = await this.fetcher(new URL(SEARCH_PATH, this.config.endpoint), {
        method: 'POST',
        headers: authorization(this.config, accessKey.value, secretKey.value, body, date),
        body,
        signal,
      })
      const raw = await boundedResponse(response, this.config.maxResponseBytes)
      if (!response.ok) return this.httpFailure(response.status, raw)
      const parsed = searchResponseSchema.parse(JSON.parse(raw))
      if (parsed.ResultStatus.toLocaleLowerCase() !== 'complete') {
        return { status: 'failed', reason: `TLS SearchLogs result status was ${parsed.ResultStatus}`, retryable: true }
      }
      const items = parsed.Logs.slice(0, request.limit).map(log => this.item(log, request.query, window))
      return items.length === 0 ? { status: 'empty' } : { status: 'available', items }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ResponseLimitError) {
        return { status: 'failed', reason: error.message, retryable: false }
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return { status: 'failed', reason: 'TLS SearchLogs response validation failed', retryable: false }
      }
      const reason = error instanceof Error ? error.message : 'TLS SearchLogs request failed'
      return { status: 'failed', reason: boundedText(reason, this.config.maxSummaryBytes), retryable: true }
    }
  }

  private httpFailure(status: number, body: string): DevelopmentEvidenceProviderOutcome {
    const code = errorCode(body)
    const suffix = code === undefined ? '' : `, ${code}`
    if (status === 401 || status === 403) {
      return { status: 'denied', reason: `Volcengine TLS authorization was denied (HTTP ${status}${suffix})` }
    }
    return {
      status: 'failed',
      reason: `TLS SearchLogs request failed (HTTP ${status}${suffix})`,
      retryable: status === 408 || status === 429 || status >= 500,
    }
  }

  private item(
    log: Readonly<Record<string, unknown>>,
    query: string,
    window: SearchWindow,
  ): DevelopmentEvidenceItem {
    const canonicalLog = stableJson(log)
    const revision = sha256(canonicalLog)
    const time = timestamp(log)
    const sourceName = stringField(log, '__source__')
    const path = stringField(log, '__path__')
    const content = log.content
    const contentLevel = content !== null && typeof content === 'object'
      ? stringField(content as Readonly<Record<string, unknown>>, 'level')
      : undefined
    const tags = [
      'volcengine-tls',
      this.config.topicId,
      stringField(log, 'log_type'),
      stringField(log, 'level') ?? contentLevel,
    ].filter((tag): tag is string => tag !== undefined)
    return Object.freeze({
      id: `tls-${revision.slice(0, 24)}` as DevelopmentEvidenceItemId,
      title: [time, sourceName, path].filter(value => value !== undefined).join(' ') || this.config.topicId,
      summary: boundedText(summary(log), this.config.maxSummaryBytes),
      source: `tls://search/${encodeURIComponent(this.config.topicId)}/${encodeURIComponent(time)}/${revision.slice(0, 24)}?start=${window.start}&end=${window.end}&query=${encodeURIComponent(query)}`,
      revision: `sha256:${revision}`,
      tags: Object.freeze(tags),
    })
  }
}

/** Register one TLS provider for this plugin lifetime. */
export function apply(ctx: Context, config: Config): () => void {
  const provider = new VolcengineTlsEvidenceProvider(ctx, config)
  return ctx.developmentEvidence.registerProvider(provider)
}
