/** Project hook setup and explicit membership for one observed Claude session. */

import { useId, useState } from 'react'
import type {
  ClaudeScopeJoinRequest, ClaudeScopeLeaveRequest, ClaudeScopeSessionKey,
  ClaudeScopeSetupRequest, ClaudeScopeSetupResult, ClaudeScopeSessionSummary, DevelopmentTaskId,
  ClaudeScopeProjectSetupResult, ClaudeScopeRemoveSetupResult, ClaudeScopeContributionDetail,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SourceContributionPanel, type SourceContributionActions } from './SourceContributionPanel.tsx'
import type { ContributionEntry } from './contribution-directory.ts'
import type { ClaudeScopeState } from './claude-scopes.ts'
import css from './ClaudeScopePanel.module.css'

/** Plain Host snapshots and actions supplied by the parent panel. */
export interface ClaudeScopePanelProps extends PropsLocale<'emergenceCenter'>, SourceContributionActions {
  readonly contributions: Readonly<Partial<Record<ClaudeScopeSessionKey, ContributionEntry<ClaudeScopeContributionDetail>>>>
  readonly state: ClaudeScopeState
  readonly taskId?: DevelopmentTaskId
  readonly localTask: boolean
  readonly setup: (request: ClaudeScopeSetupRequest) => Promise<ClaudeScopeSetupResult>
  readonly check: (request: ClaudeScopeSetupRequest) => Promise<ClaudeScopeProjectSetupResult>
  readonly remove: (request: ClaudeScopeSetupRequest) => Promise<ClaudeScopeRemoveSetupResult>
  readonly join: (request: ClaudeScopeJoinRequest) => Promise<ClaudeScopeSessionSummary>
  readonly leave: (request: ClaudeScopeLeaveRequest) => Promise<ClaudeScopeSessionSummary>
  readonly refresh: () => void
}

function actionError(error: unknown) {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
  switch (code) {
    case 'claude-scope/project-invalid': return 'claude.projectInvalid'
    case 'claude-scope/configuration-conflict': return 'claude.configurationConflict'
    case 'claude-scope/configuration-invalid': return 'claude.configurationInvalid'
    case 'claude-scope/configuration-too-large': return 'claude.configurationTooLarge'
    case 'claude-scope/write-failed': return 'claude.writeFailed'
    default: return 'claude.actionFailed'
  }
}

/**
 * Configure a project's hooks and authorize one independently selected session.
 * @param props - current Task, observable directory snapshot, and localized actions.
 * @returns project setup and recipient membership controls.
 */
export function ClaudeScopePanel({ state, taskId, localTask, setup, check, remove, join, leave, refresh,
  contributions, readContribution, requestContribution, prepareContribution, activateContribution, stopContribution,
  leaveJointContribution, recoverJointContribution, probeContributionEntry, previewContributionText, t,
}: ClaudeScopePanelProps) {
  const id = useId()
  const [projectPath, setProjectPath] = useState('')
  const [selected, setSelected] = useState<ClaudeScopeSessionKey>()
  const [responsibility, setResponsibility] = useState('')
  const [roots, setRoots] = useState('')
  const [pending, setPending] = useState<'setup' | 'check' | 'remove' | 'join' | 'leave'>()
  const [error, setError] = useState<ReturnType<typeof actionError>>()
  const session = state.sessions.find(item => item.sessionKey === selected)
  const busy = pending !== undefined
  const available = state.status === 'ready'
  const project = state.project?.projectPath === projectPath.trim() ? state.project : undefined
  const parsedRoots = [...new Set(roots.split('\n').map(value => value.trim()).filter(Boolean))]
  const perform = async (action: typeof pending, operation: () => Promise<unknown>): Promise<void> => {
    setPending(action)
    setError(undefined)
    try { await operation() }
    catch (reason) { setError(actionError(reason)) }
    finally { setPending(undefined) }
  }
  const choose = (next: ClaudeScopeSessionSummary): void => {
    setSelected(next.sessionKey)
    setResponsibility(next.responsibility ?? '')
    setRoots(next.cwd ?? projectPath.trim())
    setError(undefined)
  }
  const configure = async (): Promise<void> => { setProjectPath((await setup({ projectPath: projectPath.trim() })).projectPath) }
  const inspect = async (): Promise<void> => { setProjectPath((await check({ projectPath: projectPath.trim() })).projectPath) }
  return <section className={css.section} aria-labelledby={`${id}-title`}>
    <header className={css.header}>
      <h3 id={`${id}-title`}>{t('claude.title')}</h3>
      <Button size="sm" variant="ghost" disabled={busy || state.status === 'loading'} onClick={refresh}>{t('claude.refresh')}</Button>
    </header>
    <p className={css.description}>{t('claude.description')}</p>
    {state.status === 'unavailable' ? <p className={css.notice} role="status">{t('claude.unavailable')}</p> : <>
      <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        void perform('setup', configure)
      }}>
        <label className={css.field} htmlFor={`${id}-project`}>{t('claude.projectPath')}
          <Input id={`${id}-project`} value={projectPath} required disabled={busy}
            placeholder={t('claude.projectPlaceholder')} onChange={(event) => { setProjectPath(event.target.value) }} />
        </label>
        <p className={css.hint}>{t('claude.setupHint')}</p>
        <div className={css.actions}>
          <Button variant="outline" type="submit" disabled={busy || !available || projectPath.trim() === ''}>
            {pending === 'setup' ? t('claude.configuring') : t('claude.configure')}
          </Button>
          <Button variant="ghost" disabled={busy || !available || projectPath.trim() === ''}
            onClick={() => { void perform('check', inspect) }}>
            {pending === 'check' ? t('claude.checking') : t('claude.check')}
          </Button>
        </div>
      </form>
      {project !== undefined && <div className={css.notice} role="status">
        <strong>{t(project.state === 'configured' ? 'claude.configured' : project.state === 'conflict' ? 'claude.configurationConflict' : 'claude.notConfigured')}</strong>
        <span>{project.settingsPath}</span>
        {project.state === 'configured' && <p>{t('claude.afterSetup')}</p>}
        {project.state !== 'not-configured' && <>
          <Button size="sm" variant="ghost" disabled={busy || !available}
            onClick={() => { void perform('remove', () => remove({ projectPath: project.projectPath })) }}>
            {pending === 'remove' ? t('claude.removing') : t('claude.remove')}
          </Button>
        </>}
        <p>{t('claude.removeHint')}</p>
      </div>}
      {state.status === 'loading' && <p className={css.hint} role="status">{t('claude.loading')}</p>}
      {state.status === 'error' && <p className={css.error} role="alert">{t('claude.readFailed')}</p>}
      {available && state.sessions.length === 0 && <p className={css.empty}>{t('claude.empty')}</p>}
      {state.sessions.length > 0 && <fieldset className={css.sessions} disabled={busy || !available}>
        <legend>{t('claude.chooseSession')}</legend>
        {state.sessions.map(item => <label key={item.sessionKey} className={css.session}
          data-selected={selected === item.sessionKey || undefined}>
          <input type="radio" name={`${id}-session`} value={item.sessionKey} checked={selected === item.sessionKey}
            disabled={item.ended && item.sharingState !== 'withdrawal-pending' && item.contributionState !== 'withdrawal-pending'
              && (item.joint === undefined || !item.joint.cleanupPending
                && (item.joint.state === 'ended' || item.joint.state === 'superseded'))} onChange={() => { choose(item) }} />
          <span className={css.sessionBody}>
            <span className={css.sessionLine}><code>{item.sessionId}</code><span>{t(item.sharingState === 'withdrawal-pending' ? 'claude.withdrawalPending' : item.ended ? 'claude.ended' : item.sharingState === 'awaiting-approval' ? 'claude.awaitingApproval' : item.sharingState === 'active' ? 'claude.active' : item.taskId === undefined ? 'claude.observed' : 'claude.joined')}</span></span>
            <span className={css.path}>{item.cwd ?? t('claude.cwdUnknown')}</span>
            {item.withdrawalTaskId !== undefined && <span className={css.hint}>{t('claude.withdrawalTask', { taskId: item.withdrawalTaskId })}</span>}
            {item.sharingIssue !== undefined && <span className={css.hint}>{t(`claude.issue.${item.sharingIssue}`)}</span>}
            {item.taskId !== undefined && <span className={css.hint}>{item.taskId === taskId ? t('claude.currentTask') : t('claude.otherTask', { taskId: item.taskId })}</span>}
          </span>
        </label>)}
      </fieldset>}
      {session !== undefined && <SourceContributionPanel key={session.sessionKey}
        session={session} entry={contributions[session.sessionKey]}
        readContribution={readContribution} requestContribution={requestContribution}
        prepareContribution={prepareContribution} activateContribution={activateContribution}
        stopContribution={stopContribution} leaveJointContribution={leaveJointContribution}
        recoverJointContribution={recoverJointContribution} probeContributionEntry={probeContributionEntry}
        previewContributionText={previewContributionText} t={t} />}
      {taskId !== undefined && session !== undefined && !session.ended && session.contributionState === undefined
        && session.receiveSubscriptionId === undefined
        && (session.joint === undefined || session.joint.state === 'ended' || session.joint.state === 'superseded') &&
        <form className={css.form} onSubmit={(event) => {
          event.preventDefault()
          void perform('join', () => join({ sessionKey: session.sessionKey, taskId, responsibility: responsibility.trim(), roots: parsedRoots, bashCommands: [] }))
        }}>
          <label className={css.field} htmlFor={`${id}-responsibility`}>{t('claude.responsibility')}
            <Input id={`${id}-responsibility`} value={responsibility} required disabled={busy}
              placeholder={t('claude.responsibilityPlaceholder')} onChange={(event) => { setResponsibility(event.target.value) }} />
          </label>
          <label className={css.field} htmlFor={`${id}-roots`}>{t('claude.roots')}
            <textarea id={`${id}-roots`} value={roots} required rows={2} disabled={busy}
              onChange={(event) => { setRoots(event.target.value) }} />
          </label>
          <p className={css.hint}>{t('claude.grantHint')}</p>
          {!localTask && <p className={css.notice}>{t('claude.remoteApproval')}</p>}
          <div className={css.actions}>
            <Button type="submit" variant="primary" disabled={busy || !available || session.sharingState === 'withdrawal-pending' || responsibility.trim() === '' || parsedRoots.length === 0}>
              {pending === 'join' ? t('claude.joining') : t(session.taskId === taskId ? 'claude.updateGrant' : 'claude.join')}
            </Button>
            {session.taskId !== undefined && <Button variant="outline" disabled={busy || !available}
              onClick={() => { void perform('leave', () => leave({ sessionKey: session.sessionKey })) }}>
              {pending === 'leave' ? t('claude.leaving') : t('claude.leave')}
            </Button>}
          </div>
        </form>}
      {session?.sharingState === 'withdrawal-pending' && <div className={css.notice} role="status">
        <p>{t('claude.withdrawalHint')}</p>
        <Button variant="outline" disabled={busy || !available}
          onClick={() => { void perform('leave', () => leave({ sessionKey: session.sessionKey })) }}>
          {pending === 'leave' ? t('claude.leaving') : t('claude.retryWithdrawal')}
        </Button>
      </div>}
      {error !== undefined && <p className={css.error} role="alert">{t(error)}</p>}
    </>}
  </section>
}
