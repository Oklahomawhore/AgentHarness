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
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'

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

interface MockResponse {
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly lossy?: boolean
}

function reader(text: string, lossy = false): SubprocessOutputReader {
  return {
    readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy }),
  }
}

class MockSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []

  constructor(ctx: Context, private readonly responses: MockResponse[]) {
    super(ctx)
  }

  override resolveExecutable(command: string): Promise<string> {
    expect(command).toBe('viking-cli')
    return Promise.resolve('/mock/viking-cli')
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('unexpected spawn')
    return {
      pid: 42,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: reader(response.stdout, response.lossy),
        stderr: reader(response.stderr ?? '', response.lossy),
      },
      done: Promise.resolve({
        exitCode: response.exitCode === undefined ? 0 : response.exitCode,
        signal: response.signal === undefined ? null : response.signal,
      }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal not supported'))
  }
}

const config: Config = {
  providerId: 'agentharness-viking-knowledge',
  label: 'AgentHarness Viking Knowledge',
  executable: 'viking-cli',
  collection: 'agentharness_fde_warehouse',
  project: 'KOX',
  region: 'cn-beijing',
  cloud: 'volcengine',
  cwd: '/workspace',
  accessKeyRef: 'AGENTHARNESS_VIKING_ACCESS_KEY',
  secretKeyRef: 'AGENTHARNESS_VIKING_SECRET_KEY',
  maxOutputBytes: 65_536,
  maxSummaryBytes: 32,
  graceMs: 1_000,
}

function response(items: unknown[]): string {
  return JSON.stringify({ message: 'success', data: { count: items.length, result_list: items } })
}

async function bench(
  responses: MockResponse[],
  credentials: ReadonlyMap<string, string> = new Map([
    ['AGENTHARNESS_VIKING_ACCESS_KEY', 'ak-secret'],
    ['AGENTHARNESS_VIKING_SECRET_KEY', 'sk-secret'],
  ]),
) {
  const ctx = new Context()
  contexts.push(ctx)
  new DevelopmentEvidenceService(ctx, {
    maxQueryBytes: 256,
    maxItemsPerProvider: 5,
    maxItemTextBytes: 512,
    maxTagsPerItem: 8,
    providerTimeoutMs: 1_000,
  })
  new MemoryCredentials(ctx, credentials)
  const subprocess = new MockSubprocess(ctx, responses)
  const dispose = await apply(ctx, config)
  return { ctx, subprocess, dispose }
}

describe('VikingKnowledgeEvidenceProvider', () => {
  it('returns bounded citations with stable attribution and keeps credentials out of argv', async () => {
    const { ctx, subprocess, dispose } = await bench([{ stdout: response([{
      point_id: 'point-7',
      process_time: 170,
      update_time: 171,
      content: '共享开发房间需要保留精确来源与 revision，这段文本故意超过摘要上限。',
      doc_info: { doc_id: 'doc-2', doc_name: 'Harness review', doc_type: 'minutes' },
    }]) }])

    const result = await ctx.developmentEvidence.query({
      query: 'shared room evidence',
      providerIds: ['agentharness-viking-knowledge' as DevelopmentEvidenceProviderId],
      limit: 2,
    })

    expect(result.providers).toMatchObject([{
      providerId: 'agentharness-viking-knowledge',
      status: 'available',
      items: [{
        id: 'point-7',
        title: 'Harness review',
        source: 'viking://knowledge/agentharness_fde_warehouse/doc-2?point=point-7',
        revision: '171',
        tags: ['viking-knowledge', 'agentharness_fde_warehouse', 'minutes'],
      }],
    }])
    const provider = result.providers[0]
    if (provider?.status !== 'available') throw new Error('expected available evidence')
    expect(Buffer.byteLength(provider.items[0]!.summary)).toBeLessThanOrEqual(config.maxSummaryBytes)
    expect(subprocess.specs[0]).toMatchObject({
      argv: ['/mock/viking-cli', 'knowledge', 'search-knowledge', '-collection', 'agentharness_fde_warehouse', '-query', 'shared room evidence', '-limit', '2', '-project', 'KOX'],
      env: { VIKING_AK: 'ak-secret', VIKING_SK: 'sk-secret', VIKING_REGION: 'cn-beijing' },
    })
    expect(subprocess.specs[0]!.argv).not.toContain('ak-secret')
    dispose()
    expect(ctx.developmentEvidence.listProviders()).toEqual([])
  })

  it('distinguishes an empty search from missing credentials', async () => {
    const available = await bench([{ stdout: response([]) }])
    await expect(available.ctx.developmentEvidence.query({ query: 'absent' })).resolves.toMatchObject({
      providers: [{ status: 'empty' }],
    })

    const denied = await bench([], new Map())
    await expect(denied.ctx.developmentEvidence.query({ query: 'private' })).resolves.toMatchObject({
      providers: [{ status: 'denied', reason: 'Viking Knowledge credentials are not configured' }],
    })
    expect(denied.subprocess.specs).toEqual([])
  })

  it('preserves CLI authorization failures instead of reporting an empty search', async () => {
    const { ctx } = await bench([{ stdout: '', stderr: 'PermissionDenied: AK is unauthorized', exitCode: 1 }])
    await expect(ctx.developmentEvidence.query({ query: 'restricted' })).resolves.toMatchObject({
      providers: [{ status: 'denied', reason: 'Viking Knowledge authorization was denied' }],
    })
  })

  it('reports invalid or truncated CLI output as a non-retryable provider failure', async () => {
    const invalid = await bench([{ stdout: '{not-json' }])
    await expect(invalid.ctx.developmentEvidence.query({ query: 'broken' })).resolves.toMatchObject({
      providers: [{ status: 'failed', retryable: false }],
    })

    const truncated = await bench([{ stdout: response([]), lossy: true }])
    await expect(truncated.ctx.developmentEvidence.query({ query: 'large' })).resolves.toMatchObject({
      providers: [{ status: 'failed', reason: 'Viking Knowledge CLI output exceeded maxOutputBytes', retryable: false }],
    })
  })
})
