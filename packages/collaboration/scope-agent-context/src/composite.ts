/** Exact combined projection identities and final local authority checks around asynchronous peer reads. */

import { createHash } from 'node:crypto'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { localContextProjectionSchema, readLocalTaskContext, nextTaskContextExpiry } from '@deepseek-ai/dsh-development-task-context/local'
import { projectionSchema } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeAccessProjection, ScopeRetrieveResult } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentBinding, ScopeAgentCompositeBinding, ScopeAgentCompositeProjection, ScopeAgentLocalBinding } from './types.ts'
import { scopeContextFramingBytes } from './messages.ts'

/**
 * Identify bindings that require the installed Task admission consumer.
 * @param binding - current scheduling interval.
 * @returns whether an exact local assignment is retained.
 */
export function hasLocal(binding: ScopeAgentBinding | null): binding is ScopeAgentLocalBinding | ScopeAgentCompositeBinding {
  return binding?.kind === 'local-task' || binding?.kind === 'local-task-scope'
}

function digest(local: ScopeAgentCompositeProjection['local'], remote: ScopeAccessProjection, maxContextBytes: number) {
  return createHash('sha256').update(JSON.stringify(['local-task-scope', local.projectionId, remote.projectionId, maxContextBytes]))
    .digest('hex') as ScopeAccessProjection['projectionId']
}

/** Strict combined attribution preserves both independent projection identities. */
export const compositeProjectionSchema: z.ZodType<ScopeAgentCompositeProjection> = z.object({
  kind: z.literal('local-task-scope'), version: z.literal(1), local: localContextProjectionSchema, remote: projectionSchema,
  maxContextBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  projectionId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ScopeAccessProjection['projectionId']),
  taskRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, ctx) => {
  if (value.taskRevision !== value.remote.taskRevision
    || value.projectionId !== digest(value.local, value.remote, value.maxContextBytes)) {
    ctx.addIssue({ code: 'custom', message: 'combined projection identity differs from its exact inputs' })
  }
})

/**
 * Build one scheduling identity for two independently authorized request inputs.
 * @param local - exact local Root Task projection.
 * @param remote - exact online remote projection.
 * @param maxContextBytes - shared complete message budget.
 * @returns attributable combined input identity.
 */
export function compositeProjection(local: ScopeAgentCompositeProjection['local'], remote: ScopeAccessProjection,
  maxContextBytes: number): ScopeAgentCompositeProjection {
  return { kind: 'local-task-scope', version: 1, local, remote, maxContextBytes,
    taskRevision: remote.taskRevision, projectionId: digest(local, remote, maxContextBytes) }
}

// The synchronous current() check establishes these installed Cordis services.
function original(value: object | undefined): object {
  return (value as Record<symbol, object>)[symbols.original] as object
}

/**
 * Allocate local text first, then retrieve a bounded remote projection and recheck local authority synchronously.
 * @param ctx - current owner services and independent remote access.
 * @param binding - explicit local assignment and remote subscription.
 * @param maxContextBytes - total final UTF-8 text bytes, including remote framing.
 * @param maxLocalContextBytes - validated positive local allowance leaving room for remote framing and text.
 * @param signal - request and binding lifetime cancellation.
 * @param current - synchronous final assignment and installed-consumer validation.
 * @returns both exact inputs, or the observed remote/local termination.
 */
export async function readComposite(ctx: Context, binding: ScopeAgentCompositeBinding, maxContextBytes: number,
  maxLocalContextBytes: number, signal: AbortSignal, current: () => boolean): Promise<Exclude<ScopeRetrieveResult, { status: 'active' }>
    | { readonly status: 'active'; readonly projection: ScopeAgentCompositeProjection }> {
  while (true) {
    signal.throwIfAborted()
    if (!current()) return { status: 'left' }
    const tasks = original(ctx.get('developmentTasks'))
    const backend = original(ctx.get('developmentTaskContextBackend'))
    const expiresAt = nextTaskContextExpiry((ctx.get('developmentTasks') as Context['developmentTasks']).get({ taskId: binding.target.taskId }).context)
    const framingBytes = scopeContextFramingBytes()
    const local = await readLocalTaskContext(ctx, binding.target, maxLocalContextBytes, signal)
    signal.throwIfAborted()
    if (local.status !== 'active') return local
    const localBytes = Buffer.byteLength(local.projection.text, 'utf8')
    const remaining = maxContextBytes - localBytes - framingBytes
    const remote = await ctx.scopeAccess.retrieveWithinBudget({ subscriptionId: binding.subscriptionId,
      maxContextBytes: remaining }, signal)
    signal.throwIfAborted()
    if (remote.status !== 'active') return remote
    if (!current()) return { status: 'left' }
    const currentTasks = ctx.get('developmentTasks') as Context['developmentTasks']
    if (tasks !== original(currentTasks) || backend !== original(ctx.get('developmentTaskContextBackend'))
      || expiresAt <= Date.now()
      || currentTasks.get({ taskId: binding.target.taskId }).revision !== local.projection.taskRevision) continue
    if (remote.projection.expiresAt <= Date.now()) return { status: 'expired' }
    return { status: 'active', projection: compositeProjection(local.projection, remote.projection, maxContextBytes) }
  }
}
