/** Pinned read authorization shared by application, wire, and durable parsers. */
import { isDeepStrictEqual } from 'node:util'
import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { z } from 'zod'
import type { ScopeGeneration, ScopeGrantId, ScopeInvitation } from './types.ts'

const peer = z.string().min(1).max(256).transform(value => value as ScopePeerId)
const task = z.string().min(1).max(256).transform(value => value as DevelopmentTaskId)
const grantId = z.uuid().transform(value => value as ScopeGrantId)
const generation = z.uuid().transform(value => value as ScopeGeneration)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Pinned invitation admitted from local RPC, peer requests, and durable records. */
export const invitationSchema: z.ZodType<ScopeInvitation> = z.object({
  version: z.literal(1), ownerPeerId: peer, ownerAddress: z.string().min(1).max(2048), recipientPeerId: peer,
  taskId: task, grantId, generation, expiresAt: integer, responsibility: z.string().trim().min(1).max(1024),
}).strict()

/**
 * Compare the complete read permission independently of its current transport route.
 * @param left - first strictly parsed invitation.
 * @param right - second strictly parsed invitation.
 * @returns true only when every permission and identity field is unchanged.
 */
export function sameReadGrant(left: ScopeInvitation, right: ScopeInvitation): boolean {
  return isDeepStrictEqual({ ...left, ownerAddress: right.ownerAddress }, right)
}
