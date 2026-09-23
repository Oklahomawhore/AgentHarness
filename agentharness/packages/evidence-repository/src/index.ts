/** Read-only Git worktree evidence provider for AgentHarness development rooms. */

import { createHash } from 'node:crypto'
import { isAbsolute, posix, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {
  DevelopmentEvidenceItem,
  DevelopmentEvidenceItemId,
  DevelopmentEvidenceProvider,
  DevelopmentEvidenceProviderId,
  DevelopmentEvidenceProviderOutcome,
  DevelopmentEvidenceProviderQuery,
} from '@deepseek-ai/dsh-development-evidence'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Cordis plugin identity shown in Loader diagnostics. */
export const name = 'agentharness-evidence-repository'
/** Host services required by this provider. */
export const inject = ['developmentEvidence', 'subprocess']

/** Repository identity, search behavior, and process resource policy. */
export interface Config {
  /** Unique lower-kebab identity registered with the evidence registry. */
  readonly providerId: string
  /** Operator-facing source label. */
  readonly label: string
  /** Git executable name or absolute path. */
  readonly executable: string
  /** Repository root or a directory inside the target worktree. */
  readonly root: string
  /** Stable deployment identity used in citations instead of an absolute local path. */
  readonly repositoryId: string
  /** Git pathspecs searched relative to the resolved worktree root. */
  readonly pathspecs: string[]
  /** Whether tracked and non-ignored untracked files are both searched. */
  readonly includeUntracked: boolean
  /** Whether fixed-string matching ignores case. */
  readonly ignoreCase: boolean
  /** Maximum segmented query terms passed to Git. */
  readonly maxQueryTerms: number
  /** Minimum Unicode characters retained in one segmented query term. */
  readonly minTermCharacters: number
  /** Maximum matches accepted from one file before Git stops scanning it. */
  readonly maxMatchesPerFile: number
  /** Maximum collected bytes for each Git output stream. */
  readonly maxOutputBytes: number
  /** Maximum UTF-8 bytes retained from one matching line. */
  readonly maxSummaryBytes: number
  /** Process-tree termination grace in milliseconds. */
  readonly graceMs: number
}

/** Loader-visible repository provider configuration. */
export const Config: s<Config> = s.object({
  providerId: s.string().required(),
  label: s.string().required(),
  executable: s.string().required(),
  root: s.string().required(),
  repositoryId: s.string().required(),
  pathspecs: s.array(s.string()).required(),
  includeUntracked: s.boolean().required(),
  ignoreCase: s.boolean().required(),
  maxQueryTerms: s.number().step(1).min(1).required(),
  minTermCharacters: s.number().step(1).min(1).required(),
  maxMatchesPerFile: s.number().step(1).min(1).required(),
  maxOutputBytes: s.number().step(1).min(1).required(),
  maxSummaryBytes: s.number().step(1).min(4).required(),
  graceMs: s.number().step(1).min(1).required(),
})

interface GitMatch {
  readonly path: string
  readonly line: number
  readonly content: string
}

type ResolvedConfig = Omit<Config, 'pathspecs'> & { readonly pathspecs: readonly string[] }

interface CollectedOutput {
  readonly stdout: string
  readonly stderr: string
  readonly lossy: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`agentharness-repository-evidence: ${field} must be a positive safe integer`)
  }
  return value
}

function utf8TextLimit(value: number, field: string): number {
  const normalized = positive(value, field)
  if (normalized < 4) throw new TypeError(`agentharness-repository-evidence: ${field} must be at least 4 bytes`)
  return normalized
}

function text(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`agentharness-repository-evidence: ${field} must not be blank`)
  return normalized
}

function list(values: readonly string[], field: string): readonly string[] {
  if (values.length === 0) throw new TypeError(`agentharness-repository-evidence: ${field} must not be empty`)
  return Object.freeze(values.map(value => text(value, field)))
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

function read(reader: SubprocessOutputReader | undefined): { text: string; lossy: boolean } {
  if (reader === undefined) throw new Error('agentharness-repository-evidence: subprocess dropped collected output')
  const result = reader.readFrom(0)
  return { text: result.text, lossy: result.lossy }
}

async function collect(handle: SubprocessHandle): Promise<CollectedOutput> {
  const outcome = await handle.done
  const stdout = read(handle.collected.stdout)
  const stderr = read(handle.collected.stderr)
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    lossy: stdout.lossy || stderr.lossy,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  }
}

function parseMatches(raw: string): GitMatch[] {
  const matches: GitMatch[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const pathEnd = raw.indexOf('\0', cursor)
    const lineEnd = pathEnd < 0 ? -1 : raw.indexOf('\0', pathEnd + 1)
    const contentEnd = lineEnd < 0 ? -1 : raw.indexOf('\n', lineEnd + 1)
    if (pathEnd < 1 || lineEnd < 0 || contentEnd < 0) {
      throw new TypeError('Git grep returned an incomplete null-delimited record')
    }
    const path = raw.slice(cursor, pathEnd)
    const lineText = raw.slice(pathEnd + 1, lineEnd)
    const content = raw.slice(lineEnd + 1, contentEnd).replace(/\r$/u, '')
    const line = Number(lineText)
    const normalized = posix.normalize(path)
    if (!Number.isSafeInteger(line) || line < 1) throw new TypeError('Git grep returned an invalid line number')
    if (isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) {
      throw new TypeError('Git grep returned a path outside the repository')
    }
    matches.push({ path, line, content })
    cursor = contentEnd + 1
  }
  return matches
}

function queryTerms(query: string, maxTerms: number, minCharacters: number): readonly string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  const terms: string[] = []
  const seen = new Set<string>()
  for (const part of segmenter.segment(query)) {
    if (!part.isWordLike) continue
    const normalized = part.segment.toLocaleLowerCase()
    if ([...normalized].length < minCharacters || seen.has(normalized)) continue
    seen.add(normalized)
    terms.push(normalized)
    if (terms.length >= maxTerms) break
  }
  return Object.freeze(terms.length === 0 ? [query.trim()] : terms)
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function failure(message: string): DevelopmentEvidenceProviderOutcome {
  const reason = message.trim() || 'Git repository query failed'
  if (/permission|access.?denied|operation not permitted|dubious ownership/iu.test(reason)) {
    return { status: 'denied', reason: 'Repository access was denied' }
  }
  const retryable = !/not a git repository|unknown option|invalid pathspec|outside repository/iu.test(reason)
  return { status: 'failed', reason, retryable }
}

/** Read-only provider over one resolved Git worktree. */
export class RepositoryEvidenceProvider implements DevelopmentEvidenceProvider {
  readonly id: DevelopmentEvidenceProviderId
  readonly label: string
  private readonly config: ResolvedConfig

  /**
   * Freeze validated search policy and the repository root resolved during plugin load.
   * @param ctx - Host context providing managed subprocesses.
   * @param config - explicit repository identity, search behavior, and resource bounds.
   * @param executable - canonical Git executable resolved by the subprocess provider.
   * @param root - canonical Git worktree root returned by `git rev-parse`.
   */
  constructor(
    private readonly ctx: Context,
    config: Config,
    private readonly executable: string,
    private readonly root: string,
  ) {
    this.id = text(config.providerId, 'providerId') as DevelopmentEvidenceProviderId
    this.label = text(config.label, 'label')
    this.config = Object.freeze({
      providerId: this.id,
      label: this.label,
      executable: text(config.executable, 'executable'),
      root: text(config.root, 'root'),
      repositoryId: text(config.repositoryId, 'repositoryId'),
      pathspecs: list(config.pathspecs, 'pathspecs'),
      includeUntracked: config.includeUntracked,
      ignoreCase: config.ignoreCase,
      maxQueryTerms: positive(config.maxQueryTerms, 'maxQueryTerms'),
      minTermCharacters: positive(config.minTermCharacters, 'minTermCharacters'),
      maxMatchesPerFile: positive(config.maxMatchesPerFile, 'maxMatchesPerFile'),
      maxOutputBytes: positive(config.maxOutputBytes, 'maxOutputBytes'),
      maxSummaryBytes: utf8TextLimit(config.maxSummaryBytes, 'maxSummaryBytes'),
      graceMs: positive(config.graceMs, 'graceMs'),
    })
  }

  /**
   * Search tracked and optionally non-ignored untracked text without publishing results.
   * @param request - normalized query and evidence-registry result bound.
   * @param signal - registry cancellation and timeout signal.
   * @returns ranked line citations or an explicit empty, denied, or failed outcome.
   */
  async query(
    request: DevelopmentEvidenceProviderQuery,
    signal: AbortSignal,
  ): Promise<DevelopmentEvidenceProviderOutcome> {
    const terms = queryTerms(request.query, this.config.maxQueryTerms, this.config.minTermCharacters)
    signal.throwIfAborted()
    const result = await collect(this.spawn(terms, signal))
    if (result.lossy) {
      return { status: 'failed', reason: 'Git grep output exceeded maxOutputBytes', retryable: false }
    }
    if (result.signal !== null) return { status: 'failed', reason: `Git grep terminated by ${result.signal}`, retryable: true }
    if (result.exitCode === 1) return { status: 'empty' }
    if (result.exitCode !== 0) return failure(result.stderr || result.stdout)
    try {
      const items = this.rank(parseMatches(result.stdout), terms)
        .slice(0, request.limit)
        .map(match => this.item(match))
      return items.length === 0 ? { status: 'empty' } : { status: 'available', items }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid Git grep output'
      return { status: 'failed', reason: `Git grep response validation failed: ${reason}`, retryable: false }
    }
  }

  private spawn(terms: readonly string[], signal: AbortSignal): SubprocessHandle {
    return this.ctx.subprocess.spawn({
      argv: [
        this.executable,
        '-C', this.root,
        'grep',
        '--null',
        '-n',
        '-I',
        '--full-name',
        '--no-color',
        '--fixed-strings',
        `--max-count=${this.config.maxMatchesPerFile}`,
        ...(this.config.includeUntracked ? ['--untracked'] : []),
        ...(this.config.ignoreCase ? ['--ignore-case'] : []),
        ...terms.flatMap(term => ['-e', term]),
        '--',
        ...this.config.pathspecs,
      ],
      cwd: this.root,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      graceMs: this.config.graceMs,
      signal,
    })
  }

  private rank(matches: readonly GitMatch[], terms: readonly string[]): GitMatch[] {
    const unique = new Map<string, GitMatch>()
    for (const match of matches) unique.set(`${match.path}\0${match.line}`, match)
    return [...unique.values()].sort((left, right) => {
      const leftText = left.content.toLocaleLowerCase()
      const rightText = right.content.toLocaleLowerCase()
      const score = (value: string) => terms.reduce((count, term) => count + Number(value.includes(term)), 0)
      return score(rightText) - score(leftText)
        || left.path.localeCompare(right.path)
        || left.line - right.line
    })
  }

  private item(match: GitMatch): DevelopmentEvidenceItem {
    const contentRevision = fingerprint(`${this.config.repositoryId}\0${match.path}\0${match.line}\0${match.content}`)
    const extension = posix.extname(match.path).slice(1)
    return Object.freeze({
      id: `git-${contentRevision.slice(0, 24)}` as DevelopmentEvidenceItemId,
      title: `${match.path.replace(/[\u0000-\u001f\u007f]/gu, '�')}:${match.line}`,
      summary: boundedText(match.content, this.config.maxSummaryBytes),
      source: `git://worktree/${encodeURIComponent(this.config.repositoryId)}/${encodePath(match.path)}#L${match.line}`,
      revision: `sha256:${contentRevision}`,
      tags: Object.freeze(['git', 'repository', this.config.repositoryId, ...(extension === '' ? [] : [extension])]),
    })
  }
}

async function resolveRepositoryRoot(
  ctx: Context,
  executable: string,
  config: Config,
): Promise<string> {
  const maxOutputBytes = positive(config.maxOutputBytes, 'maxOutputBytes')
  const graceMs = positive(config.graceMs, 'graceMs')
  const root = resolve(text(config.root, 'root'))
  const result = await collect(ctx.subprocess.spawn({
    argv: [executable, '-C', root, 'rev-parse', '--show-toplevel'],
    cwd: root,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: maxOutputBytes },
      stderr: { maxBytes: maxOutputBytes },
    },
    graceMs,
  }))
  if (result.lossy) throw new Error('agentharness-repository-evidence: git rev-parse output exceeded maxOutputBytes')
  if (result.signal !== null || result.exitCode !== 0) {
    throw new Error(`agentharness-repository-evidence: repository root resolution failed: ${(result.stderr || result.stdout).trim() || 'git exited unsuccessfully'}`)
  }
  return resolve(text(result.stdout, 'resolved repository root'))
}

/** Resolve Git and the worktree root at load, then register one provider for this plugin lifetime. */
export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const executable = await ctx.subprocess.resolveExecutable(text(config.executable, 'executable'))
  const root = await resolveRepositoryRoot(ctx, executable, config)
  const provider = new RepositoryEvidenceProvider(ctx, config, executable, root)
  return ctx.developmentEvidence.registerProvider(provider)
}
