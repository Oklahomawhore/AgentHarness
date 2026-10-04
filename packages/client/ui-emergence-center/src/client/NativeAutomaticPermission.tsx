/** Explicit finite execution fields shared by local and remote receivers. */
import type { ScopeAgentAutomaticPolicy } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeScopeAction.module.css'

/** Uncommitted automatic permission; a filled draft alone grants nothing. */
export interface NativeAutomaticDraft {
  readonly goal: string
  readonly extra: string
  readonly steps: string
  readonly interval: string
}

/**
 * Add explicit finite reservations to the latest confirmed lifetime usage.
 * @param draft - user-entered goal, additional starts, step limit and seconds between starts.
 * @param used - lifetime reservations already consumed, including cancelled starts.
 * @returns a complete policy, or undefined while inputs are incomplete or exceed safe bounds.
 */
export function automaticPolicy(draft: NativeAutomaticDraft, used: number): ScopeAgentAutomaticPolicy | undefined {
  const { goal, extra, steps, interval } = draft
  if ([goal, extra, steps, interval].some(value => value.trim() === '')) return undefined
  const added = Number(extra)
  const maxStepsPerTurn = Number(steps)
  const minIntervalMs = Number(interval) * 1_000
  const activationLimit = used + added
  if (!Number.isSafeInteger(added) || added < 1 || !Number.isSafeInteger(maxStepsPerTurn) || maxStepsPerTurn < 1
    || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 2_147_483_647
    || !Number.isSafeInteger(activationLimit) || goal.trim().length > 8192) return undefined
  return { goal: goal.trim(), activationLimit, maxStepsPerTurn, minIntervalMs }
}

/**
 * Render finite automatic permission without sending commands or granting file access.
 * @param props - local draft, latest usage, editable state and localized labels.
 * @returns controlled fields and a preview of the permission the user must submit.
 */
export function NativeAutomaticPermission({ id, draft, used, disabled, change, t }: PropsLocale<'emergenceCenter'> & {
  id: string
  draft: NativeAutomaticDraft
  used: number
  disabled: boolean
  change: (draft: NativeAutomaticDraft) => void
}) {
  const policy = automaticPolicy(draft, used)
  return <fieldset className={css.modes} disabled={disabled}>
    <label className={css.field} htmlFor={`${id}-goal`}>{t('native.goal')}
      <textarea id={`${id}-goal`} required maxLength={8192} rows={3} value={draft.goal}
        onChange={(event) => { change({ ...draft, goal: event.target.value }) }} /></label>
    <div className={css.numbers}>
      <label className={css.field} htmlFor={`${id}-extra`}>{t('native.extra')}
        <Input id={`${id}-extra`} type="number" required min="1" step="1" value={draft.extra}
          onChange={(event) => { change({ ...draft, extra: event.target.value }) }} /></label>
      <label className={css.field} htmlFor={`${id}-steps`}>{t('native.steps')}
        <Input id={`${id}-steps`} type="number" required min="1" step="1" value={draft.steps}
          onChange={(event) => { change({ ...draft, steps: event.target.value }) }} /></label>
      <label className={css.field} htmlFor={`${id}-interval`}>{t('native.interval')}
        <Input id={`${id}-interval`} type="number" required min="0" step="0.001" value={draft.interval}
          onChange={(event) => { change({ ...draft, interval: event.target.value }) }} /></label>
    </div>
    {policy !== undefined && <p className={css.confirm}>{t('native.confirm', { goal: policy.goal, count: Number(draft.extra) })}</p>}
  </fieldset>
}
