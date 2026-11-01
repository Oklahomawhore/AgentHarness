/** Strict durable identities, original receiving plans, and exact prepared hook projections. */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { legacySubscriptionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeSubscription } from '@deepseek-ai/dsh-scope-access/types'
import { externalScopeProjectionSchema, externalScopeReceiveSchema,
  type ExternalScopeProjection, type ExternalScopeReceive } from '@deepseek-ai/dsh-scope-access/receiving'
import { z } from 'zod'
import type { CodexScopeClientId, CodexScopeSessionKey } from './types.ts'

/** Original preallocated subscription and local intent survive uncertain adoption or termination. */
export interface CodexScopeReceiving {
  readonly plan: ScopeSubscription
  readonly status: ExternalScopeReceive['status']
}

/** Observed logical receiving scope, independent of native Harness Sessions. */
export interface CodexScopeSession {
  readonly sessionKey: CodexScopeSessionKey
  readonly clientId: CodexScopeClientId
  readonly sessionId: string
  readonly cwd?: string | undefined
  readonly observedAt: number
  readonly readRevision: number
  readonly receive?: CodexScopeReceiving | undefined
  readonly lastProjectionId?: string | undefined
}

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const opaque = z.string().min(1).max(256)
const key = z.string().regex(/^codex-session-[a-f0-9]{64}$/).transform(value => value as CodexScopeSessionKey)
const clientId = opaque.transform(value => value as CodexScopeClientId)
const projectionSchema = externalScopeProjectionSchema.safeExtend({
  projectionId: z.string().regex(/^codex-projection-[a-f0-9]{64}$/), sessionKey: key,
  previousProjectionId: z.string().regex(/^codex-projection-[a-f0-9]{64}$/).optional(),
})
const planSchema = legacySubscriptionSchema.safeExtend({ state: z.literal('active') })
  .transform(({ routeRevision, ...plan }) => routeRevision === undefined ? plan : { ...plan, routeRevision })
const sessionSchema: z.ZodType<CodexScopeSession> = z.object({
  sessionKey: key, clientId, sessionId: opaque, cwd: z.string().refine(isAbsolute).optional(),
  observedAt: integer, readRevision: integer,
  receive: z.object({ plan: planSchema,
    status: externalScopeReceiveSchema.shape.status }).strict().optional(),
  lastProjectionId: z.string().regex(/^codex-projection-[a-f0-9]{64}$/).optional(),
}).strict()

/** Durable receiving records fail startup on invalid identities or associations. */
export const codexScopeDomainSpec = defineDomain({
  name: 'codex_scope', version: 1,
  global: { schema: z.object({ installationId: z.uuid().nullable() }).strict(), initial: { installationId: null } },
  tables: {
    sessions: domainTable<CodexScopeSessionKey, CodexScopeSession>(sessionSchema),
    projections: domainTable<string, ExternalScopeProjection<CodexScopeSessionKey>>(projectionSchema),
  },
})

/**
 * Derive an installation-local identity without publishing the external session ID.
 * @param installationId - durable adapter installation identity.
 * @param client - stable configured Codex client identity.
 * @param sessionId - Codex logical session identity.
 * @returns deterministic local inventory key.
 */
export function codexScopeSessionKey(installationId: string, client: CodexScopeClientId, sessionId: string): CodexScopeSessionKey {
  return `codex-session-${createHash('sha256').update(JSON.stringify([installationId, client, sessionId])).digest('hex')}` as CodexScopeSessionKey
}

/**
 * Describe the retained receiving selection for the shared framing library.
 * @param receiving - original subscription and latest local receiving state.
 * @returns exact independent read identity; no authority is inferred from this record.
 */
export function externalReceive(receiving: CodexScopeReceiving): ExternalScopeReceive {
  const { plan, status } = receiving
  const invitation = plan.invitation
  return { subscriptionId: plan.id, generation: plan.generation, taskId: invitation.taskId, ownerPeerId: invitation.ownerPeerId,
    grantId: invitation.grantId, grantGeneration: invitation.generation, expiresAt: invitation.expiresAt, status }
}
