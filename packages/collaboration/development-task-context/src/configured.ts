/** Restart-applied backend selection; semantic execution and durable reservations remain owned by the existing provider. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import ReportedBackend from './reported.ts'
import type { Config as SemanticConfig } from '@deepseek-ai/dsh-development-task-context/semantic'
import SemanticBackend from './semantic.ts'

/** User-selected context computation, independent of ordinary Session model settings. */
export interface Selection {
  /** Deterministic reports or explicitly authorized semantic inference. */
  readonly mode: 'reported' | 'semantic'
  /** Existing LLM provider route; required and nonblank in semantic mode. */
  readonly provider: string
  /** Exact summary model; required and nonblank in semantic mode. */
  readonly model: string
  /** Cumulative reservations permitted in the deployment's retained audit Session. */
  readonly maxCalls: number
}

/** Deployment-owned execution limits and initial settings; mount with separately isolated audit persistence. */
export interface Config extends Omit<SemanticConfig, 'provider' | 'model' | 'maxCalls'> {
  /** Composition values below the durable scope-context user settings. */
  readonly selection: Selection
}

const positive = () => s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()
const selectionSchema: s<Selection> = s.object({
  mode: s.union([s.const('reported'), s.const('semantic')]).required(),
  provider: s.string().required(), model: s.string().required(), maxCalls: positive(),
})

/** Loader validation for the deployment limits and explicit initial selection. */
export const Config: s<Config> = s.object({
  selection: selectionSchema.required(), auditSessionId: s.string().required(),
  temperature: s.number(), reasoningEffort: s.string(), maxInputBytes: positive(), maxOutputTokens: positive(),
  maxOutputBytes: positive(), timeoutMs: s.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  maxConcurrentCalls: positive(),
})

/** Settings and the capabilities required by either selected provider; no model adapter is resolved at startup. */
export const inject = ['settings', 'llm', 'sessions', 'sessionPersistence']

function validateSelection(value: Selection): void {
  if (value.mode === 'semantic' && (value.provider.trim() === '' || value.model.trim() === '')) {
    throw new Error('scope-context: semantic mode requires a provider and model')
  }
}

/** Mount one backend from the startup selection without preparing or dispatching a model request.
 * @param ctx - Settings owner and the deployment's isolated audit-persistence realm.
 * @param config - Fixed audit identity, execution limits, and settings base values.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.auditSessionId.trim() === '' || config.reasoningEffort?.trim() === '') {
    throw new Error('scope-context: audit identity and configured reasoning effort must be nonblank')
  }
  const settings = ctx.settings.register('scope-context', selectionSchema, {
    base: config.selection, applies: 'restart', validate: validateSelection,
  })
  const selection = settings.get()
  if (selection.mode === 'reported') {
    await ctx.plugin(ReportedBackend).await()
  } else {
    const { selection: _selection, ...execution } = config
    await ctx.plugin(SemanticBackend, { ...execution, provider: selection.provider, model: selection.model,
      maxCalls: selection.maxCalls }).await()
  }
}
