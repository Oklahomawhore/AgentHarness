/** Strict durable and peer-wire parsing for recipient-pinned scope reads. */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { z } from 'zod'
import { invitationSchema, projectionSchema } from './schema.ts'
import { applicationRecordSchema, type ApplicationRecord } from './application-schema.ts'
import type {
  ScopeChangeCursor, ScopeGeneration, ScopeGrantId, ScopeAccessProjection,
  ScopeReadGrant, ScopeSubscription, ScopeSubscriptionId, ScopeContributionEntryId,
} from './types.ts'

const peer = z.string().min(1).max(256).transform(value => value as ScopePeerId)
const generation = z.uuid().transform(value => value as ScopeGeneration)
const subscriptionId = z.uuid().transform(value => value as ScopeSubscriptionId)

const grant: z.ZodType<ScopeReadGrant> = z.object({ invitation: invitationSchema, state: z.enum(['active', 'revoked']) }).strict()
const subscription: z.ZodType<ScopeSubscription> = z.object({
  id: subscriptionId, generation, invitation: invitationSchema, state: z.enum(['active', 'left', 'revoked', 'expired']),
}).strict()

/** Read-only peer request; recipient routing comes exclusively from the owner's stored grant. */
export const readRequestSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), subscriptionId, generation, invitation: invitationSchema,
}).strict()

/** Response echoes one request identity; denied responses carry no scope metadata. */
export const readResponseSchema = z.object({
  requestId: z.uuid(), subscriptionId, generation,
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('active'), projection: projectionSchema }).strict(),
    z.object({ status: z.enum(['revoked', 'expired', 'unavailable', 'denied']) }).strict(),
  ]),
}).strict()

const cursor = z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ScopeChangeCursor)

/** Authorized change comparison; an absent cursor requests immediate current-state alignment. */
export const waitRequestSchema = readRequestSchema.extend({ cursor: cursor.optional() })

/** A correlated change hint exposes no Task revision, text, or source coverage. */
export const waitResponseSchema = z.object({
  requestId: z.uuid(), subscriptionId, generation,
  result: z.discriminatedUnion('status', [
    z.object({ status: z.enum(['changed', 'unchanged']), cursor }).strict(),
    z.object({ status: z.enum(['revoked', 'expired', 'unavailable', 'denied']) }).strict(),
  ]),
}).strict()

/** Durable authorization records remain bound to the transport key that created them. */
export const scopeAccessDomainSpec = defineDomain({
  name: 'scope_access', version: 1,
  global: { schema: z.object({ peerId: peer.nullable() }).strict(), initial: { peerId: null } },
  tables: {
    applications: domainTable<ScopeContributionEntryId, ApplicationRecord>(applicationRecordSchema),
    grants: domainTable<ScopeGrantId, ScopeReadGrant>(grant),
    subscriptions: domainTable<ScopeSubscriptionId, ScopeSubscription>(subscription),
    projections: domainTable<string, ScopeAccessProjection>(projectionSchema),
  },
})

/** Open authoritative scope authorization state. */
export type ScopeAccessDomain = Domain<typeof scopeAccessDomainSpec>
