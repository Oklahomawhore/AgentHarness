/** Strict receiving variants preserve historical subscriptions without inferring source associations. */
import { z } from 'zod'
import type { DevelopmentTaskContextPeerCapture } from '@deepseek-ai/dsh-development-task-context/types'
import type { ScopeOriginalCapture, ScopeSubscription, ScopeGeneration, ScopeSubscriptionId } from './types.ts'
import { invitationSchema } from './invitation-schema.ts'

const opaque = z.string().min(1).max(256).refine(value => value.trim().length > 0)
/** Exact source coordinates accepted at durable and wire boundaries. */
export const originalCaptureSchema = z.object({
  captureId: opaque.transform(value => value as ScopeOriginalCapture['captureId']),
  captureGeneration: opaque.transform(value => value as ScopeOriginalCapture['captureGeneration']),
}).strict()

/** Complete owner-selected contribution interval, independent of local Session identifiers. */
export const peerCaptureSchema: z.ZodType<DevelopmentTaskContextPeerCapture> = originalCaptureSchema.extend({
  ownerPeerId: opaque.transform(value => value as DevelopmentTaskContextPeerCapture['ownerPeerId']),
  contributorPeerId: opaque.transform(value => value as DevelopmentTaskContextPeerCapture['contributorPeerId']),
  taskId: opaque.transform(value => value as DevelopmentTaskContextPeerCapture['taskId']),
  grantId: opaque.transform(value => value as DevelopmentTaskContextPeerCapture['grantId']),
  generation: opaque.transform(value => value as DevelopmentTaskContextPeerCapture['generation']),
})

/** Unversioned subscriptions retain their original strict fields. */
export const legacySubscriptionSchema = z.object({
  id: z.uuid().transform(value => value as ScopeSubscriptionId),
  generation: z.uuid().transform(value => value as ScopeGeneration),
  invitation: invitationSchema, state: z.enum(['active', 'left', 'revoked', 'expired']),
  routeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()

/** Source-associated subscriptions are an explicit new persisted representation. */
export const captureSubscriptionSchema = legacySubscriptionSchema.extend({ version: z.literal(2), originalCapture: originalCaptureSchema })

/** Parse both generations without adding a source identity to historical data. */
export const subscriptionSchema: z.ZodType<ScopeSubscription> = z.union([legacySubscriptionSchema, captureSubscriptionSchema])
  .transform(({ routeRevision, ...subscription }) => routeRevision === undefined ? subscription : { ...subscription, routeRevision })
