/** Finite owner-local automatic work, independent of file-sharing permission. */
import { useId, useRef, useState } from 'react'
import type { ScopeAgentLocalContributionBinding } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { automaticPolicy, NativeAutomaticPermission, type NativeAutomaticDraft } from './NativeAutomaticPermission.tsx'
import { sameLocalTarget, type NativeScopeAction, type NativeScopeSnapshot } from './native-scopes.ts'
import css from './NativeScopeAction.module.css'

/**
 * Manage one already connected Task; the parent keys this form by assignment and execution binding.
 * @param props - exact observed assignment, current execution status and single-flight commands.
 * @returns separate automatic-work permission and a guarded whole-Task departure action.
 */
export function NativeLocalAutomaticPanel({ assignment, snapshot, act, t }: PropsLocale<'emergenceCenter'> & {
  assignment: ScopeAgentLocalContributionBinding
  snapshot: NativeScopeSnapshot
  act: (action: NativeScopeAction) => Promise<boolean>
}) {
  const id = useId()
  const busy = useRef(false)
  const [selected, setSelected] = useState(false)
  const [draft, setDraft] = useState<NativeAutomaticDraft>({ goal: '', extra: '', steps: '', interval: '' })
  const observation = snapshot.observation
  const status = observation?.eligibility === 'not-live' ? undefined : observation
  const state = status?.state
  const target = { taskId: assignment.taskId, taskBindingId: assignment.bindingId,
    expectedBindingEpoch: assignment.expectedBindingEpoch }
  const ready = snapshot.phase === 'ready' && !snapshot.pending && status !== undefined && status !== null
    && sameLocalTarget(status.localTask, target)
  const composite = state?.binding?.kind === 'local-task-scope' ? state.binding : null
  const binding = state?.binding?.kind === 'local-task' ? state.binding : composite
  const matched = binding !== null && sameLocalTarget(target, { taskId: binding.target.taskId,
    taskBindingId: binding.target.taskBindingId, expectedBindingEpoch: binding.target.bindingEpoch })
  const eligible = ready && (status.eligibility === 'eligible' || status.eligibility === 'task-conflict')
    && (state?.binding === null || state?.binding?.kind === 'local-task')
  const enabled = composite === null && matched && state?.mode === 'enabled'
  const currentPolicy = matched ? composite === null ? state?.automatic : composite.retainedLocal.automatic : null
  const used = state?.usedBudget ?? 0
  const policy = automaticPolicy(draft, used)
  const expectedBindingId = state?.binding?.id ?? null
  const perform = async (action: NativeScopeAction): Promise<void> => {
    if (!ready || busy.current) return
    busy.current = true
    try { await act(action) } finally { busy.current = false }
  }
  return <section className={css.form} data-native-local-automatic>
    <p role="status" className={css.state}>{t(!ready ? `native.phase.${snapshot.phase === 'ready' ? 'loading' : snapshot.phase}` : enabled ? 'native.mode.enabled'
      : matched && (composite !== null ? currentPolicy !== null : state?.mode === 'paused') ? 'native.mode.paused' : 'native.mode.passive')}</p>
    {composite === null && matched && state?.pauseReason != null && <p className={css.hint}>{t(`native.pause.${state.pauseReason}`)}</p>}
    <p className={css.budget}>{currentPolicy == null ? t('native.used', { used })
      : t('native.budget', { used, limit: currentPolicy.activationLimit, steps: currentPolicy.maxStepsPerTurn })}</p>
    {currentPolicy != null && <p className={css.goal}>{t('native.currentGoal', { goal: currentPolicy.goal })}</p>}
    <details>
      <summary>{t('native.local.bindingDetails')}</summary>
      <dl className={css.details}>
        <dt>{t('native.local.task')}</dt><dd>{target.taskId}</dd>
        <dt>{t('native.local.bindingId')}</dt><dd>{target.taskBindingId}</dd>
        <dt>{t('native.local.bindingEpoch')}</dt>
        <dd>{target.expectedBindingEpoch.nodeId}:{target.expectedBindingEpoch.seq}</dd>
      </dl>
    </details>
    {composite !== null && <p className={css.hint}>{t('native.local.manageShared')}</p>}
    <p className={css.hint}>{t('native.local.automaticHint')}</p>
    <div className={css.actions}>
      {enabled && <Button disabled={!ready}
        onClick={() => { void perform({ kind: 'pause', expectedBindingId: binding.id }) }}>{t('native.pause')}</Button>}
      {composite === null && !enabled && matched && currentPolicy != null && currentPolicy.activationLimit > used
        && <Button disabled={!eligible} onClick={() => {
          void perform({ kind: 'resume', expectedBindingId: binding.id, automatic: currentPolicy })
        }}>{t('native.resumeRemaining', { count: currentPolicy.activationLimit - used })}</Button>}
      {composite === null && currentPolicy != null && <Button disabled={!eligible} onClick={() => {
        void perform({ kind: 'bindLocal', request: { ...target, expectedBindingId, automatic: null } })
      }}>{t('native.disableAutomatic')}</Button>}
    </div>
    {composite === null && !enabled && <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (!eligible || !selected || policy === undefined) return
      void perform({ kind: 'bindLocal', request: { ...target, expectedBindingId, automatic: policy } })
    }}>
      <label className={css.consent}><input type="checkbox" checked={selected} disabled={!eligible}
        onChange={(event) => { setSelected(event.target.checked) }} />{t('native.local.allowAutomatic')}</label>
      {selected && <>
        <p className={css.hint}>{t('native.automaticHint')}</p>
        <NativeAutomaticPermission id={id} draft={draft} used={used} disabled={!eligible} change={setDraft} t={t} />
        <Button type="submit" variant="primary" disabled={!eligible || policy === undefined}>{t('native.resume')}</Button>
      </>}
    </form>}
    <p className={css.hint}>{t('native.pauseHint')}</p>
    <Button disabled={!ready || composite !== null} onClick={() => {
      void perform({ kind: 'leaveLocalTask', request: { ...target, expectedBindingId } })
    }}>{t('native.local.leave')}</Button>
    <p className={css.hint}>{t('native.local.leaveHint')}</p>
  </section>
}
