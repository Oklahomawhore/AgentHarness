/** Finite local automatic execution permission shared by direct and joint adoption. */

import { z } from 'zod'
import type { ScopeAgentAutomaticPolicy } from './types.ts'

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Policy admitted by management RPC and Session replay. */
export const policySchema: z.ZodType<ScopeAgentAutomaticPolicy> = z.object({
  goal: z.string().trim().min(1).max(8192), activationLimit: natural.positive(),
  maxStepsPerTurn: natural.positive(), minIntervalMs: natural.max(2_147_483_647),
}).strict()
