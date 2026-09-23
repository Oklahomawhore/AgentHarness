import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import DevelopmentEvidenceService, {
  type DevelopmentEvidenceProviderId,
} from '@deepseek-ai/dsh-development-evidence'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config, VolcengineTlsEvidenceProvider } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

class MemoryCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: ReadonlyMap<string, string>) {
    super(ctx)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'test' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), source: 'test', writable: false })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.reject(new Error('read only'))
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.reject(new Error('read only'))
  }
}

const config: Config = {
  providerId: 'agentharness-tls',
  label: 'AgentHarness Volcengine TLS',
  endpoint: 'https://tls-cn-beijing.volces.com',
  region: 'cn-beijing',
  topicId: 'topic-agent-test',
  accessKeyRef: 'AGENTHARNESS_TLS_ACCESS_KEY',
  secretKeyRef: 'AGENTHARNESS_TLS_SECRET_KEY',
  lookbackMs: 900_000,
  sort: 'desc',
  maxQueryBytes: 256,
  maxResponseBytes: 1024,
  maxSummaryBytes: 96,
}

interface FetchCall {
  readonly input: string | URL | Request
  readonly init: RequestInit | undefined
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function successful(logs: unknown[]): unknown {
  return { ResultStatus: 'complete', Count: logs.length, ListOver: true, Logs: logs }
}

function createContext(credentials: ReadonlyMap<string, string> = new Map([
  ['AGENTHARNESS_TLS_ACCESS_KEY', 'ak-test'],
  ['AGENTHARNESS_TLS_SECRET_KEY', 'sk-secret'],
])): Context {
  const ctx = new Context()
  contexts.push(ctx)
  new DevelopmentEvidenceService(ctx, {
    maxQueryBytes: 256,
    maxItemsPerProvider: 5,
    maxItemTextBytes: 8192,
    maxTagsPerItem: 8,
    providerTimeoutMs: 1_000,
  })
  new MemoryCredentials(ctx, credentials)
  return ctx
}

function bench(responses: Response[], credentials?: ReadonlyMap<string, string>) {
  const ctx = createContext(credentials)
  const calls: FetchCall[] = []
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init })
    const next = responses.shift()
    if (next === undefined) return Promise.reject(new Error('unexpected fetch'))
    return Promise.resolve(next)
  }
  const provider = new VolcengineTlsEvidenceProvider(
    ctx,
    config,
    fetcher,
    () => new Date('2026-08-19T12:00:00.000Z'),
  )
  const dispose = ctx.developmentEvidence.registerProvider(provider)
  return { ctx, calls, dispose }
}

describe('VolcengineTlsEvidenceProvider', () => {
  it('signs a bounded SearchLogs request and returns stable source-attributed citations', async () => {
    const { ctx, calls, dispose } = bench([response(successful([{
      __time__: 1_777_000_000_000,
      __source__: 'vefaas-agent-1',
      log_type: 'stdout',
      content: {
        level: 'ERROR',
        event: 'chat.background.failed',
        message: 'A deliberately long failure record used to prove UTF-8 summary bounds.',
      },
    }]))])

    const result = await ctx.developmentEvidence.query({
      query: 'content.level:ERROR',
      providerIds: ['agentharness-tls' as DevelopmentEvidenceProviderId],
      limit: 2,
    })

    expect(result.providers).toMatchObject([{
      providerId: 'agentharness-tls',
      status: 'available',
      items: [{
        title: '1777000000000 vefaas-agent-1',
        tags: ['volcengine-tls', 'topic-agent-test', 'stdout', 'ERROR'],
      }],
    }])
    const provider = result.providers[0]
    if (provider?.status !== 'available') throw new Error('expected available TLS evidence')
    expect(provider.items[0]!.id).toMatch(/^tls-[0-9a-f]{24}$/u)
    expect(provider.items[0]!.revision).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(provider.items[0]!.source).toContain('tls://search/topic-agent-test/1777000000000/')
    expect(provider.items[0]!.source).toContain('query=content.level%3AERROR')
    expect(Buffer.byteLength(provider.items[0]!.summary)).toBeLessThanOrEqual(config.maxSummaryBytes)

    expect(String(calls[0]!.input)).toBe('https://tls-cn-beijing.volces.com/SearchLogs')
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      TopicId: 'topic-agent-test',
      Query: 'content.level:ERROR',
      StartTime: 1_787_139_900_000,
      EndTime: 1_787_140_800_000,
      Limit: 2,
      Sort: 'desc',
    })
    const headers = calls[0]!.init?.headers
    if (!(headers instanceof Headers)) throw new Error('expected Headers')
    expect(headers.get('X-Date')).toBe('20260819T120000Z')
    expect(headers.get('X-Tls-Apiversion')).toBe('0.3.0')
    expect(headers.get('Authorization')).toMatch(/^HMAC-SHA256 Credential=ak-test\/20260819\/cn-beijing\/TLS\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/u)
    expect(JSON.stringify(calls[0])).not.toContain('sk-secret')
    dispose()
    expect(ctx.developmentEvidence.listProviders()).toEqual([])
  })

  it('distinguishes missing credentials, authorization denial, and retryable throttling', async () => {
    const missing = bench([], new Map())
    await expect(missing.ctx.developmentEvidence.query({ query: 'error' })).resolves.toMatchObject({
      providers: [{ status: 'denied', reason: 'Volcengine TLS credentials are not configured' }],
    })
    expect(missing.calls).toEqual([])

    const denied = bench([response({ ResponseMetadata: { Error: { Code: 'AccessDenied' } } }, 403)])
    await expect(denied.ctx.developmentEvidence.query({ query: 'private' })).resolves.toMatchObject({
      providers: [{ status: 'denied', reason: 'Volcengine TLS authorization was denied (HTTP 403, AccessDenied)' }],
    })

    const throttled = bench([response({ ResponseMetadata: { Error: { Code: 'ExceedQPSLimit' } } }, 429)])
    await expect(throttled.ctx.developmentEvidence.query({ query: 'busy' })).resolves.toMatchObject({
      providers: [{ status: 'failed', reason: 'TLS SearchLogs request failed (HTTP 429, ExceedQPSLimit)', retryable: true }],
    })
  })

  it('fails closed on SQL analysis, incomplete, malformed, and oversized responses', async () => {
    const sql = bench([])
    await expect(sql.ctx.developmentEvidence.query({ query: '* | select count(*)' })).resolves.toMatchObject({
      providers: [{ status: 'failed', retryable: false }],
    })
    expect(sql.calls).toEqual([])

    const incomplete = bench([response({ ResultStatus: 'Incomplete', Logs: [] })])
    await expect(incomplete.ctx.developmentEvidence.query({ query: 'error' })).resolves.toMatchObject({
      providers: [{ status: 'failed', reason: 'TLS SearchLogs result status was Incomplete', retryable: true }],
    })

    const malformed = bench([response('{not-json')])
    await expect(malformed.ctx.developmentEvidence.query({ query: 'error' })).resolves.toMatchObject({
      providers: [{ status: 'failed', reason: 'TLS SearchLogs response validation failed', retryable: false }],
    })

    const oversized = bench([response('x'.repeat(config.maxResponseBytes + 1))])
    await expect(oversized.ctx.developmentEvidence.query({ query: 'error' })).resolves.toMatchObject({
      providers: [{ status: 'failed', reason: 'TLS SearchLogs response exceeded maxResponseBytes', retryable: false }],
    })
  })

  it('validates deployment access configuration at plugin load', () => {
    const ctx = createContext()
    const dispose = apply(ctx, config)
    expect(ctx.developmentEvidence.listProviders()).toMatchObject([{ id: 'agentharness-tls' }])
    dispose()
    expect(ctx.developmentEvidence.listProviders()).toEqual([])

    expect(() => apply(ctx, { ...config, endpoint: 'http://tls.example.com' })).toThrow('endpoint must be an HTTPS origin')
    expect(() => apply(ctx, { ...config, secretKeyRef: 'not a ref' })).toThrow('credential reference')
  })
})
