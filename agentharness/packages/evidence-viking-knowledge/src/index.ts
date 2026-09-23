/** Viking Knowledge provider for the AgentHarness development-evidence seam. */

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
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'

/** Cordis plugin identity shown in Loader diagnostics. */
export const name = 'agentharness-evidence-viking-knowledge'
/** Host services required by this provider. */
export const inject = ['credentials', 'developmentEvidence', 'subprocess']

/** Deployment and resource policy for one Viking Knowledge collection. */
export interface Config {
  /** Unique lower-kebab identity registered with the evidence seam. */
  readonly providerId: string
  /** Operator-facing source label. */
  readonly label: string
  /** Viking CLI executable name or absolute path. */
  readonly executable: string
  /** Exact Viking Knowledge collection name. */
  readonly collection: string
  /** Exact Viking project name. */
  readonly project: string
  /** Viking API region. */
  readonly region: string
  /** Viking cloud identifier. */
  readonly cloud: string
  /** Working directory handed to the managed CLI process. */
  readonly cwd: string
  /** Credential reference containing the Viking access key. */
  readonly accessKeyRef: string
  /** Credential reference containing the Viking secret key. */
  readonly secretKeyRef: string
  /** Maximum collected bytes for each CLI output stream. */
  readonly maxOutputBytes: number
  /** Maximum UTF-8 bytes retained from one retrieved chunk. */
  readonly maxSummaryBytes: number
  /** Process-tree termination grace in milliseconds. */
  readonly graceMs: number
}

/** Loader-visible provider configuration schema. */
export const Config: s<Config> = s.object({
  providerId: s.string().required(),
  label: s.string().required(),
  executable: s.string().required(),
  collection: s.string().required(),
  project: s.string().required(),
  region: s.string().required(),
  cloud: s.string().required(),
  cwd: s.string().required(),
  accessKeyRef: s.string().required(),
  secretKeyRef: s.string().required(),
  maxOutputBytes: s.number().step(1).min(1).required(),
  maxSummaryBytes: s.number().step(1).min(4).required(),
  graceMs: s.number().step(1).min(1).required(),
})

const resultItemSchema = z.object({
  point_id: z.string().min(1),
  process_time: z.number().int().optional(),
  update_time: z.number().int().optional(),
  content: z.string().min(1),
  doc_info: z.object({
    doc_id: z.string().min(1),
    doc_name: z.string().min(1),
    doc_type: z.string().optional(),
  }).passthrough(),
}).passthrough()

const responseSchema = z.object({
  data: z.object({
    result_list: z.array(resultItemSchema),
  }).passthrough(),
}).passthrough()

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function credentialRef(value: string): CredentialRef {
  if (!CREDENTIAL_REF_PATTERN.test(value)) {
    throw new TypeError(`agentharness-viking-knowledge: credential reference "${value}" must match ${String(CREDENTIAL_REF_PATTERN)}`)
  }
  return value as CredentialRef
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`agentharness-viking-knowledge: ${field} must be a positive safe integer`)
  }
  return value
}

function utf8TextLimit(value: number, field: string): number {
  const normalized = positive(value, field)
  if (normalized < 4) throw new TypeError(`agentharness-viking-knowledge: ${field} must be at least 4 bytes`)
  return normalized
}

function text(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`agentharness-viking-knowledge: ${field} must not be blank`)
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

function output(reader: SubprocessOutputReader | undefined): { text: string; lossy: boolean } {
  if (reader === undefined) throw new Error('agentharness-viking-knowledge: subprocess dropped collected output')
  const result = reader.readFrom(0)
  return { text: result.text, lossy: result.lossy }
}

function failure(message: string): DevelopmentEvidenceProviderOutcome {
  const denied = /auth|credential|permission|forbidden|unauthorized|access.?denied|\bAK\b|\bSK\b|鉴权|权限|认证/iu.test(message)
  if (denied) return { status: 'denied', reason: 'Viking Knowledge authorization was denied' }
  const retryable = !/not found|does not exist|不存在/iu.test(message)
  return { status: 'failed', reason: message.trim() || 'Viking Knowledge query failed', retryable }
}

/** Read-only provider backed by one explicit Viking Knowledge collection. */
export class VikingKnowledgeEvidenceProvider implements DevelopmentEvidenceProvider {
  readonly id: DevelopmentEvidenceProviderId
  readonly label: string
  private readonly config: Config

  /**
   * Freeze validated deployment policy and the resolved execution-world CLI path.
   * @param ctx - Host context providing credentials and managed subprocesses.
   * @param config - explicit collection, credentials, and resource bounds.
   * @param executable - canonical executable resolved by the subprocess provider.
   */
  constructor(
    private readonly ctx: Context,
    config: Config,
    private readonly executable: string,
  ) {
    this.id = text(config.providerId, 'providerId') as DevelopmentEvidenceProviderId
    this.label = text(config.label, 'label')
    this.config = Object.freeze({
      providerId: this.id,
      label: this.label,
      executable: text(config.executable, 'executable'),
      collection: text(config.collection, 'collection'),
      project: text(config.project, 'project'),
      region: text(config.region, 'region'),
      cloud: text(config.cloud, 'cloud'),
      cwd: text(config.cwd, 'cwd'),
      accessKeyRef: text(config.accessKeyRef, 'accessKeyRef'),
      secretKeyRef: text(config.secretKeyRef, 'secretKeyRef'),
      maxOutputBytes: positive(config.maxOutputBytes, 'maxOutputBytes'),
      maxSummaryBytes: utf8TextLimit(config.maxSummaryBytes, 'maxSummaryBytes'),
      graceMs: positive(config.graceMs, 'graceMs'),
    })
  }

  /**
   * Search the configured collection without publishing results to a room or Session.
   * @param request - normalized query and evidence-registry result bound.
   * @param signal - registry cancellation and timeout signal.
   * @returns bounded citations or an explicit empty, denied, or failed outcome.
   */
  async query(
    request: DevelopmentEvidenceProviderQuery,
    signal: AbortSignal,
  ): Promise<DevelopmentEvidenceProviderOutcome> {
    const [accessKey, secretKey] = await Promise.all([
      this.ctx.credentials.resolve(credentialRef(this.config.accessKeyRef)),
      this.ctx.credentials.resolve(credentialRef(this.config.secretKeyRef)),
    ])
    if (accessKey === undefined || secretKey === undefined) {
      return { status: 'denied', reason: 'Viking Knowledge credentials are not configured' }
    }
    signal.throwIfAborted()
    const handle = this.spawn(request, signal, accessKey.value, secretKey.value)
    const outcome = await handle.done
    const stdout = output(handle.collected.stdout)
    const stderr = output(handle.collected.stderr)
    if (stdout.lossy || stderr.lossy) {
      return { status: 'failed', reason: 'Viking Knowledge CLI output exceeded maxOutputBytes', retryable: false }
    }
    if (outcome.exitCode !== 0 || outcome.signal !== null) return failure(stderr.text || stdout.text)
    try {
      const parsed = responseSchema.parse(JSON.parse(stdout.text))
      const items = parsed.data.result_list.slice(0, request.limit).map(item => this.item(item))
      return items.length === 0 ? { status: 'empty' } : { status: 'available', items }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid Viking Knowledge response'
      return { status: 'failed', reason: `Viking Knowledge response validation failed: ${reason}`, retryable: false }
    }
  }

  private spawn(
    request: DevelopmentEvidenceProviderQuery,
    signal: AbortSignal,
    accessKey: string,
    secretKey: string,
  ): SubprocessHandle {
    return this.ctx.subprocess.spawn({
      argv: [
        this.executable,
        'knowledge',
        'search-knowledge',
        '-collection', this.config.collection,
        '-query', request.query,
        '-limit', String(request.limit),
        '-project', this.config.project,
      ],
      cwd: this.config.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      graceMs: this.config.graceMs,
      signal,
      env: {
        VIKING_AK: accessKey,
        VIKING_SK: secretKey,
        VIKING_REGION: this.config.region,
        VIKING_PROJECT: this.config.project,
        VIKING_CLOUD: this.config.cloud,
      },
    })
  }

  private item(item: z.infer<typeof resultItemSchema>): DevelopmentEvidenceItem {
    const revision = item.update_time ?? item.process_time
    return Object.freeze({
      id: item.point_id as DevelopmentEvidenceItemId,
      title: item.doc_info.doc_name,
      summary: boundedText(item.content, this.config.maxSummaryBytes),
      source: `viking://knowledge/${encodeURIComponent(this.config.collection)}/${encodeURIComponent(item.doc_info.doc_id)}?point=${encodeURIComponent(item.point_id)}`,
      revision: revision === undefined ? item.point_id : String(revision),
      tags: Object.freeze(['viking-knowledge', this.config.collection, ...(item.doc_info.doc_type === undefined ? [] : [item.doc_info.doc_type])]),
    })
  }
}

/** Resolve the CLI at load and register one provider for this plugin lifetime. */
export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const executable = await ctx.subprocess.resolveExecutable(text(config.executable, 'executable'))
  const provider = new VikingKnowledgeEvidenceProvider(ctx, config, executable)
  return ctx.developmentEvidence.registerProvider(provider)
}
