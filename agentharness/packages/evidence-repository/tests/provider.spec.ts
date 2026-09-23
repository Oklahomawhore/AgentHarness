import { Context } from '@deepseek-ai/cordis'
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
    expect(command).toBe('git')
    return Promise.resolve('/mock/git')
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
  providerId: 'agentharness-repository',
  label: 'AgentHarness Repository',
  executable: 'git',
  root: '/workspace/checkout',
  repositoryId: 'agentharness-agents',
  pathspecs: ['packages', 'docs'],
  includeUntracked: true,
  ignoreCase: true,
  maxQueryTerms: 6,
  minTermCharacters: 2,
  maxMatchesPerFile: 4,
  maxOutputBytes: 65_536,
  maxSummaryBytes: 48,
  graceMs: 1_000,
}

function records(...matches: Array<{ path: string; line: number; content: string }>): string {
  return matches.map(match => `${match.path}\0${match.line}\0${match.content}\n`).join('')
}

async function bench(responses: MockResponse[]) {
  const ctx = new Context()
  contexts.push(ctx)
  new DevelopmentEvidenceService(ctx, {
    maxQueryBytes: 256,
    maxItemsPerProvider: 5,
    maxItemTextBytes: 512,
    maxTagsPerItem: 8,
    providerTimeoutMs: 1_000,
  })
  const subprocess = new MockSubprocess(ctx, [
    { stdout: '/workspace/repository\n' },
    ...responses,
  ])
  const dispose = await apply(ctx, config)
  return { ctx, subprocess, dispose }
}

describe('RepositoryEvidenceProvider', () => {
  it('ranks bounded worktree citations and preserves stable Git attribution', async () => {
    const { ctx, subprocess, dispose } = await bench([{ stdout: records(
      { path: 'docs/room.md', line: 9, content: 'A shared room is useful.' },
      { path: 'packages/room/index.ts', line: 27, content: 'Shared development room coordination with a long UTF-8 摘要内容用于验证字节边界。' },
    ) }])

    const result = await ctx.developmentEvidence.query({
      query: 'shared development room',
      providerIds: ['agentharness-repository' as DevelopmentEvidenceProviderId],
      limit: 2,
    })

    expect(result.providers).toMatchObject([{
      providerId: 'agentharness-repository',
      status: 'available',
      items: [
        {
          title: 'packages/room/index.ts:27',
          source: 'git://worktree/agentharness-agents/packages/room/index.ts#L27',
          tags: ['git', 'repository', 'agentharness-agents', 'ts'],
        },
        {
          title: 'docs/room.md:9',
          source: 'git://worktree/agentharness-agents/docs/room.md#L9',
        },
      ],
    }])
    const provider = result.providers[0]
    if (provider?.status !== 'available') throw new Error('expected available repository evidence')
    expect(provider.items[0]!.id).toMatch(/^git-[0-9a-f]{24}$/u)
    expect(provider.items[0]!.revision).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(Buffer.byteLength(provider.items[0]!.summary)).toBeLessThanOrEqual(config.maxSummaryBytes)
    expect(subprocess.specs[0]!.argv).toEqual(['/mock/git', '-C', '/workspace/checkout', 'rev-parse', '--show-toplevel'])
    expect(subprocess.specs[1]!.argv).toEqual([
      '/mock/git', '-C', '/workspace/repository', 'grep', '--null', '-n', '-I', '--full-name', '--no-color',
      '--fixed-strings', '--max-count=4', '--untracked', '--ignore-case',
      '-e', 'shared', '-e', 'development', '-e', 'room', '--', 'packages', 'docs',
    ])
    dispose()
    expect(ctx.developmentEvidence.listProviders()).toEqual([])
  })

  it('distinguishes no matches from repository access denial', async () => {
    const empty = await bench([{ stdout: '', exitCode: 1 }])
    await expect(empty.ctx.developmentEvidence.query({ query: 'absent' })).resolves.toMatchObject({
      providers: [{ status: 'empty' }],
    })

    const denied = await bench([{ stdout: '', stderr: 'fatal: detected dubious ownership in repository', exitCode: 128 }])
    await expect(denied.ctx.developmentEvidence.query({ query: 'private' })).resolves.toMatchObject({
      providers: [{ status: 'denied', reason: 'Repository access was denied' }],
    })
  })

  it('rejects truncated and malformed Git output instead of returning partial evidence', async () => {
    const truncated = await bench([{ stdout: records({ path: 'a.ts', line: 1, content: 'match' }), lossy: true }])
    await expect(truncated.ctx.developmentEvidence.query({ query: 'match' })).resolves.toMatchObject({
      providers: [{ status: 'failed', reason: 'Git grep output exceeded maxOutputBytes', retryable: false }],
    })

    const malformed = await bench([{ stdout: '../secret\0x\0match\n' }])
    await expect(malformed.ctx.developmentEvidence.query({ query: 'match' })).resolves.toMatchObject({
      providers: [{ status: 'failed', retryable: false }],
    })
  })

  it('fails plugin load when the configured directory is not a Git worktree', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    new DevelopmentEvidenceService(ctx, {
      maxQueryBytes: 256,
      maxItemsPerProvider: 5,
      maxItemTextBytes: 512,
      maxTagsPerItem: 8,
      providerTimeoutMs: 1_000,
    })
    new MockSubprocess(ctx, [{ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }])

    await expect(apply(ctx, config)).rejects.toThrow('repository root resolution failed: fatal: not a git repository')
    expect(ctx.developmentEvidence.listProviders()).toEqual([])
  })
})
