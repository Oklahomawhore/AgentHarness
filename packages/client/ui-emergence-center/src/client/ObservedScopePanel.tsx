/** Explicit owner approval for remote bindings observed in the selected Task. */

import { useId, useState } from 'react'
import type {
  DevelopmentTaskApproveObservedIntervalRequest, DevelopmentTaskEndObservedIntervalRequest,
  DevelopmentTaskId, DevelopmentTaskObservedInterval, DevelopmentTaskObservedIntervalIdentity,
  DevelopmentTaskObservedReceipt,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservedScopeState } from './observed-scopes.ts'
import css from './ClaudeScopePanel.module.css'

/** Owner-side query snapshots and explicit authorization actions. */
export interface ObservedScopePanelProps extends PropsLocale<'emergenceCenter'> {
  readonly taskId: DevelopmentTaskId
  readonly state: ObservedScopeState
  readonly approve: (request: DevelopmentTaskApproveObservedIntervalRequest) => Promise<DevelopmentTaskObservedInterval>
  readonly end: (request: DevelopmentTaskEndObservedIntervalRequest) => Promise<DevelopmentTaskObservedReceipt>
  readonly refresh: () => void
}

function sameBinding(a: DevelopmentTaskObservedIntervalIdentity, b: DevelopmentTaskObservedIntervalIdentity): boolean {
  return a.taskId === b.taskId && a.sourceNodeId === b.sourceNodeId && a.participantId === b.participantId
    && a.bindingId === b.bindingId && a.expectedBindingEpoch.nodeId === b.expectedBindingEpoch.nodeId
    && a.expectedBindingEpoch.seq === b.expectedBindingEpoch.seq
}

function identity(value: DevelopmentTaskObservedIntervalIdentity): DevelopmentTaskObservedIntervalIdentity {
  return {
    taskId: value.taskId, sourceNodeId: value.sourceNodeId, participantId: value.participantId,
    bindingId: value.bindingId, expectedBindingEpoch: value.expectedBindingEpoch,
  }
}

/**
 * Display replicated remote bindings separately from approved observation intervals.
 * @param props - selected owner Task, current directory, actions, and translations.
 * @returns approval and termination controls that never infer consent from presence.
 */
export function ObservedScopePanel({ taskId, state, approve, end, refresh, t }: ObservedScopePanelProps) {
  const id = useId()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const matching = state.taskId === taskId
  const intervals = matching ? state.intervals : []
  const candidates = matching ? state.candidates.filter(candidate => !intervals.some(interval => sameBinding(candidate, interval))) : []
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    setFailed(false)
    try { await operation() }
    catch { setFailed(true) }
    finally { setPending(false) }
  }
  return <section className={css.section} aria-labelledby={`${id}-title`}>
    <header className={css.header}>
      <h3 id={`${id}-title`}>{t('observed.title')}</h3>
      <Button size="sm" variant="ghost" disabled={pending} onClick={refresh}>{t('observed.refresh')}</Button>
    </header>
    <p className={css.description}>{t('observed.description')}</p>
    {(!matching || state.status === 'loading') && <p className={css.hint} role="status">{t('observed.loading')}</p>}
    {matching && state.status === 'error' && <p className={css.error} role="alert">{t('observed.readFailed')}</p>}
    {matching && state.status === 'ready' && candidates.length === 0 && intervals.length === 0 && <p className={css.empty}>{t('observed.empty')}</p>}
    {candidates.map(candidate => <article key={`${candidate.bindingId}:${candidate.expectedBindingEpoch.seq}`} className={css.notice}>
      <strong>{candidate.sessionLabel ?? candidate.participantId}</strong>
      <span>{t('observed.source', { nodeId: candidate.sourceNodeId })}</span>
      <p>{t('observed.candidate')}</p>
      <Button variant="outline" disabled={pending || state.status !== 'ready'} onClick={() => { void perform(() => approve(identity(candidate))) }}>
        {t('observed.approve')}
      </Button>
    </article>)}
    {intervals.map(interval => <article key={interval.id} className={css.notice}>
      <strong>{state.candidates.find(candidate => sameBinding(candidate, interval))?.sessionLabel ?? interval.participantId}</strong>
      <span>{t('observed.source', { nodeId: interval.sourceNodeId })}</span>
      <p>{t(interval.state === 'active' ? 'observed.active' : 'observed.ended')}</p>
      {interval.state === 'active' && <Button variant="outline" disabled={pending || state.status !== 'ready'} onClick={() => { void perform(() => end(identity(interval))) }}>
        {t('observed.end')}
      </Button>}
    </article>)}
    {failed && <p className={css.error} role="alert">{t('observed.actionFailed')}</p>}
  </section>
}
