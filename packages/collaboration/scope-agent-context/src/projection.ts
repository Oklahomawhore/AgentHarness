/** Version-specific scope projection readers and scheduling event selection. */
import { projectionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeAgentReadProjection } from './types.ts'

/** Historical message and evidence versions cannot acquire a new capture association. */
export const legacyProjectionSchema = projectionSchema.refine(value => value.version !== 3,
  'historical scope projection cannot contain capture attribution')
  .transform(value => value)

/** Current capture-aware records require the owner-verified exact contribution interval. */
export const captureProjectionSchema = projectionSchema.refine(value => value.version === 3,
  'capture-aware scope projection requires exact capture attribution')
  .transform(value => value)

/** Select the durable event version required by the complete projection.
 * @param projection - Authorized local, remote, or combined scheduling input.
 * @returns The explicit event version; new capture-aware records use version 4.
 */
export function evidenceVersion(projection: ScopeAgentReadProjection): 1 | 2 | 3 | 4 {
  if ('kind' in projection) return projection.kind === 'local-task' ? 2 : projection.remote.version === 3 ? 4 : 3
  return projection.version === 3 ? 4 : 1
}
