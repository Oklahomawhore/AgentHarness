/** Read-only entry availability over an explicitly addressed authenticated peer. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z, ZodError } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import type { ScopeTransportRequest } from '@deepseek-ai/dsh-scope-transport/types'
import { DomainError } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { contributionEntrySchema, singleContributionEntrySchema, groupEntrySchema } from './contribution-schema.ts'
import type { Config } from './index.ts'
import type { ScopeAccessDomain, ScopeGroupDomain } from './state.ts'
import type { ScopeContributionEntryProbeRequest, ScopeContributionEntryProbeResult } from './types.ts'

const PROTOCOL = '/agentharness/scope-entry-probe/1'
const GROUP_PROTOCOL = '/agentharness/scope-entry-probe/2'
const inputSchema = z.object({ entry: contributionEntrySchema }).strict()
const requestSchema = z.object({ entry: singleContributionEntrySchema, version: z.literal(1), requestId: z.uuid() }).strict()
const groupRequestSchema = z.object({ entry: groupEntrySchema, version: z.literal(2), requestId: z.uuid() }).strict()
const resultSchema = z.object({
  status: z.enum(['ready', 'claimed', 'closed', 'expired', 'denied', 'capacity', 'unavailable']),
}).strict()
const responseSchema = z.object({ version: z.literal(1), requestId: z.uuid(), result: resultSchema }).strict()
const groupResponseSchema = responseSchema.extend({ version: z.literal(2) })
type Request = z.infer<typeof requestSchema> | z.infer<typeof groupRequestSchema>
type Response = z.infer<typeof responseSchema> | z.infer<typeof groupResponseSchema>
interface Owner {
  readonly config: Pick<Config, 'maxApplicationRequestBytes' | 'maxResponseBytes' | 'requestTimeoutMs' | 'maxContributionApplications'>
  readonly signal: AbortSignal
  readonly ready: () => Promise<ScopeAccessDomain>
  readonly groups: () => ScopeGroupDomain
  readonly acquire: () => (() => void) | undefined
  readonly track: <T>(operation: Promise<T>) => Promise<T>
}

/** Inspects committed application rows without reconciling or writing any authority. */
export class ContributionEntryProbe {
  /** @param ctx - authenticated transport; no Task or source collection service is used.
   * @param owner - existing scope-access readiness, lifetime, and ordinary request capacity.
   */
  constructor(private readonly ctx: Context, private readonly owner: Owner) {
    ctx.effect(() => ctx.scopeTransport.register(PROTOCOL, request => owner.track(this.respond(request, 1))),
      'scope-access: read-only entry probes')
    ctx.effect(() => ctx.scopeTransport.register(GROUP_PROTOCOL, request => owner.track(this.respond(request, 2))),
      'scope-access: read-only group entry probes')
  }

  private bounded(value: unknown, maximum: number): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) {
      throw new RemoteError('scope-contribution/capacity', 'The entry probe exceeds its byte limit.', {})
    }
  }

  private response(request: Request, result: ScopeContributionEntryProbeResult): Response {
    const response: Response = { version: request.version, requestId: request.requestId, result }
    this.bounded(response, this.owner.config.maxResponseBytes)
    return response
  }

  /** Observe an entry through its sole explicit address; no application or permission is created.
   * @param input - complete entry, whose owner and all non-address fields remain pinned.
   * @returns momentary availability; disposal rejects, and ready reserves no future admission.
   */
  async probe(input: ScopeContributionEntryProbeRequest): Promise<ScopeContributionEntryProbeResult> {
    const signal = AbortSignal.any([this.owner.signal, AbortSignal.timeout(this.owner.config.requestTimeoutMs)])
    let release: (() => void) | undefined
    try {
      signal.throwIfAborted()
      this.bounded(input, this.owner.config.maxApplicationRequestBytes)
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return { status: 'denied' }
      const request = (parsed.data.entry.version === 1 ? requestSchema : groupRequestSchema)
        .parse({ ...parsed.data, version: parsed.data.entry.version, requestId: randomUUID() })
      this.bounded(request, this.owner.config.maxApplicationRequestBytes)
      directAddress(request.entry.ownerAddress, request.entry.ownerPeerId)
      await this.owner.ready()
      signal.throwIfAborted()
      const identity = await this.ctx.scopeTransport.identity()
      signal.throwIfAborted()
      if (identity.peerId === request.entry.ownerPeerId) return { status: 'denied' }
      release = this.owner.acquire()
      if (release === undefined) return { status: 'capacity' }
      const raw = await this.ctx.scopeTransport.request({ peerId: request.entry.ownerPeerId, address: request.entry.ownerAddress },
        request.version === 1 ? PROTOCOL : GROUP_PROTOCOL, request, signal)
      signal.throwIfAborted()
      this.bounded(raw, this.owner.config.maxResponseBytes)
      const response = (request.version === 1 ? responseSchema : groupResponseSchema).parse(raw)
      return response.requestId === request.requestId ? response.result : { status: 'unavailable' }
    } catch (error) {
      if (this.owner.signal.aborted) throw error
      if (error instanceof RemoteError && error.code === 'scope-contribution/capacity') return { status: 'capacity' }
      if (error instanceof ScopeTransportError) {
        if (error.code === 'scope-transport/capacity' || error.code === 'scope-transport/request-too-large'
          || error.code === 'scope-transport/response-too-large') return { status: 'capacity' }
        if (error.code === 'scope-transport/invalid-target' || error.code === 'scope-transport/identity-invalid') return { status: 'denied' }
        return { status: 'unavailable' }
      }
      if (signal.aborted || error instanceof DomainError || error instanceof ZodError) return { status: 'unavailable' }
      throw error
    } finally { release?.() }
  }

  private async respond(input: ScopeTransportRequest, version: 1 | 2): Promise<Response> {
    this.bounded(input.payload, this.owner.config.maxApplicationRequestBytes)
    const request = (version === 1 ? requestSchema : groupRequestSchema).parse(input.payload)
    directAddress(request.entry.ownerAddress, request.entry.ownerPeerId)
    const release = this.owner.acquire()
    if (release === undefined) return this.response(request, { status: 'capacity' })
    const signal = AbortSignal.any([input.signal, this.owner.signal, AbortSignal.timeout(this.owner.config.requestTimeoutMs)])
    try {
      const domain = await this.owner.ready()
      signal.throwIfAborted()
      const identity = await this.ctx.scopeTransport.identity()
      signal.throwIfAborted()
      if (request.version === 2) {
        const groups = this.owner.groups().table('entries')
        const record = groups.get(request.entry.entryId)
        if (identity.peerId !== request.entry.ownerPeerId || input.peerId === identity.peerId || record === undefined
          || !isDeepStrictEqual({ ...record.entry, ownerAddress: request.entry.ownerAddress }, request.entry)) {
          return this.response(request, { status: 'denied' })
        }
        if (record.closed) return this.response(request, { status: 'closed' })
        if (record.entry.expiresAt <= Date.now()) return this.response(request, { status: 'expired' })
        const retained = domain.table('applications').size + [...groups.entries()]
          .reduce((total, [, group]) => total + 1 + group.members.length, 0)
        return this.response(request, { status: record.members.length >= record.entry.maxMembers
          || retained >= this.owner.config.maxContributionApplications ? 'capacity' : 'ready' })
      }
      const record = domain.table('applications').get(request.entry.entryId)
      if (identity.peerId !== request.entry.ownerPeerId || input.peerId === identity.peerId || record === undefined
        || !isDeepStrictEqual({ ...record.entry, ownerAddress: request.entry.ownerAddress }, request.entry)) {
        return this.response(request, { status: 'denied' })
      }
      if (record.decision === 'expired') return this.response(request, { status: 'expired' })
      if (record.decision !== 'open' && record.decision !== 'pending') return this.response(request, { status: 'closed' })
      if (record.entry.expiresAt <= Date.now()) return this.response(request, { status: 'expired' })
      return this.response(request, { status: record.proposal === null ? 'ready' : 'claimed' })
    } finally { release() }
  }
}
