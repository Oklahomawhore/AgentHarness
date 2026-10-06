/** Current-Session read subscription and explicit, finite automatic-work permission. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScopeInvitation, ScopeAgentContributionStatus, ScopeAgentLocalContributionStatus } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconLinkOutline14, IconChevronDownOutline14, IconCloseOutline16,
  StateDot, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NativeReadRoute } from './NativeReadRoute.tsx'
import { NativeScopeActivity } from './NativeScopeActivity.tsx'
import { NativeContributionPanel, type NativeContributionActions } from './NativeContributionPanel.tsx'
import { NativeLocalContributionPanel, type NativeLocalContributionActions } from './NativeLocalContributionPanel.tsx'
import type { DevelopmentTaskDirectory } from './task-directory.ts'
import type { ParticipantDirectory } from './participant-directory.ts'
import type { ContributionDirectory } from './contribution-directory.ts'
import type { NativeScopeAction, NativeScopeSource } from './native-scopes.ts'
import type { EmergenceCenterKey } from './locales.ts'
import { automaticPolicy, NativeAutomaticPermission } from './NativeAutomaticPermission.tsx'
import css from './NativeScopeAction.module.css'

/** One source belongs only to the Session represented by its header slot. */
export interface NativeScopeInjected extends NativeContributionActions, NativeLocalContributionActions {
  readonly hooks: {
    readonly nativeScope: NativeScopeSource
    readonly nativeContributions: ContributionDirectory<SessionId, ScopeAgentContributionStatus>
    readonly nativeLocalContributions: ContributionDirectory<SessionId, ScopeAgentLocalContributionStatus>
    readonly nativeTasks: DevelopmentTaskDirectory
    readonly nativeParticipants: ParticipantDirectory
  }
  readonly refreshNativeScope: () => void
  readonly actNativeScope: (action: NativeScopeAction) => Promise<boolean>
}

/** Header standard kit, source, and localized controls. */
export type NativeScopeActionProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<NativeScopeInjected> & PropsLocale<'emergenceCenter'>

/** Validate the invitation fields used for preview; the generated Remote validates the submitted document. */
function parseInvitation(text: string): ScopeInvitation | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object') return undefined
    const fields = value as Record<string, unknown>
    const strings = ['ownerPeerId', 'ownerAddress', 'recipientPeerId', 'taskId', 'grantId', 'generation', 'responsibility'] as const
    if (!strings.every(key => typeof fields[key] === 'string' && fields[key].trim() !== '')) return undefined
    if (!('version' in value) || value.version !== 1 || !('expiresAt' in value)
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) return undefined
    return value as ScopeInvitation
  } catch { return undefined }
}

/** Map stable RPC codes to localized recovery instructions, never raw Host messages. */
function issueKey(issue: string): EmergenceCenterKey {
  switch (issue) {
    case 'scope-agent/invalid-route': return 'native.route.invalidAddress'
    case 'scope-agent/stale-task': case 'scope-agent/stale-binding': case 'scope-agent/superseded': return 'native.error.changed'
    case 'scope-agent/not-live': return 'native.eligibility.not-live'
    case 'scope-agent/ineligible': return 'native.error.ineligible'
    case 'scope-agent/task-conflict': return 'native.eligibility.task-conflict'
    case 'scope-agent/terminal-subscription': return 'native.error.terminal'
    case 'scope-agent/budget-exhausted': return 'native.error.budget'
    default: return 'native.error.unknown'
  }
}

/**
 * Keep drafts and in-flight callbacks isolated when a header is reused for another Session.
 * @param props - current Session kit, local status source, and actions.
 * @returns the collaboration entry and optional anchored form.
 */
export function NativeScopeAction(props: NativeScopeActionProps) {
  return <SessionScopeAction key={props.sessionId} {...props} />
}

function SessionScopeAction({ useNativeScope, useNativeContributions, useNativeLocalContributions, useNativeTasks, useNativeParticipants,
  refreshNativeScope, actNativeScope,
  readNativeContribution, requestNativeContribution, stopNativeContribution, leaveNativeJoin,
  previewNativeContribution, probeNativeContribution, recoverNativeContributionRoute,
  readNativeLocalContribution, checkoutNativeLocalTask, requestNativeLocalContribution, stopNativeLocalContribution, t, ...runtime
}: NativeScopeActionProps) {
  const snapshot = useNativeScope(value => value)
  const contribution = useNativeContributions(value => value[runtime.sessionId])
  const localContribution = useNativeLocalContributions(value => value[runtime.sessionId])
  const tasks = useNativeTasks(value => value)
  const participants = useNativeParticipants(value => value)
  const [selectedLocal, setLocal] = useState<boolean>()
  const local = selectedLocal ?? (localContribution?.value?.assignment != null || localContribution?.value?.capture != null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    readNativeLocalContribution(runtime.sessionId)
    readNativeContribution(runtime.sessionId)
  }, [open, readNativeContribution, readNativeLocalContribution, runtime.sessionId])
  const [invitationText, setInvitationText] = useState('')
  const [automaticSelection, setAutomaticSelection] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [extra, setExtra] = useState('')
  const [steps, setSteps] = useState('')
  const [interval, setInterval] = useState('')
  const [success, setSuccess] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const error = useRef<HTMLParagraphElement>(null)
  const id = useId()
  const position = useAnchoredPosition({ open, anchorRef: trigger, panelRef: panel, gap: 6, margin: 16 })
  useDismissOnOutsidePointer(root, open, setOpen, panel)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (open && snapshot.issue !== null) error.current?.focus() }, [open, snapshot.issue])
  useEffect(() => {
    if (!open) return
    // State changes can remove the focused control and return focus to body.
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('keydown', dismiss, true)
    return () => { document.removeEventListener('keydown', dismiss, true) }
  }, [open])
  const observation = snapshot.observation
  const state = observation?.eligibility === 'not-live' ? undefined : observation?.state
  const bound = state?.binding?.kind === 'local-task' ? null : state?.binding ?? null
  const expectedBindingId = state?.binding?.id ?? null
  useEffect(() => { setAutomaticSelection(null) }, [expectedBindingId])
  const automaticKey = `${expectedBindingId ?? ''}/${invitationText}/${JSON.stringify(observation?.eligibility === 'not-live' ? null : observation?.localTask)}`
  const automatic = automaticSelection === automaticKey
  const eligible = observation?.eligibility === 'eligible'
  const orphanLocal = state?.binding?.kind === 'local-task'
    && observation?.eligibility !== 'not-live' && observation?.localTask === null ? state.binding : null
  const terminal = observation !== null && observation.eligibility !== 'not-live'
    && !['active', 'unbound'].includes(observation.subscriptionState)
  const ready = snapshot.phase === 'ready' && !snapshot.pending
  const invitation = parseInvitation(invitationText)
  const policy = automaticPolicy({ goal, extra, steps, interval }, state?.usedBudget ?? 0)
  const editable = ready && eligible && !terminal
  const mode = state?.mode ?? 'left'
  const label = snapshot.phase === 'ready' ? t(`native.mode.${mode}`) : t(`native.phase.${snapshot.phase}`)
  const localStatus = localContribution?.value
  const localBound = localStatus?.assignment != null || localStatus?.capture != null
  const localLabel = localContribution?.status !== 'ready' ? t('contribution.loading')
    : (state?.binding?.kind === 'local-task' || state?.binding?.kind === 'local-task-scope') && (mode === 'enabled' || mode === 'paused') ? label
      : localStatus?.capture?.state === 'ending' ? t('native.local.trigger.ending')
        : localStatus?.capture?.collecting ? t('native.local.trigger.sharing') : t('native.local.trigger.connected')
  const act = async (action: NativeScopeAction): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    setSuccess(false)
    try {
      const accepted = await actNativeScope(action)
      if (mounted.current) setSuccess(accepted)
      return accepted
    } finally { busy.current = false }
  }
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  return <div ref={root} data-native-scope className={css.root}>
    <button ref={trigger} type="button" className={css.trigger} aria-label={t('native.trigger')}
      aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => {
        setOpen(value => !value)
        if (!open) refreshNativeScope()
      }}>
      <IconLinkOutline14 /><span>{t('native.trigger')}</span>
      {localBound ? <><StateDot state={localStatus.capture?.collecting ? 'ongoing' : 'done'} />
        <span className={css.triggerState}>{localLabel}</span></> : bound !== null && <><StateDot state={mode === 'enabled' ? 'ongoing' : mode === 'paused' ? 'warning' : 'done'} />
        <span className={css.triggerState}>{label}</span></>}
      <IconChevronDownOutline14 />
    </button>
    {open && createPortal(<section ref={panel} id={`${id}-panel`} data-native-scope-panel role="dialog"
      aria-label={t('native.title')} className={css.panel} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
      <div className={css.heading}><h2>{t('native.title')}</h2><Button size="sm" aria-label={t('native.close')} onClick={close}><IconCloseOutline16 /></Button></div>
      <fieldset className={css.modes}><legend>{t('native.target')}</legend>
        <label><input type="radio" name={`${id}-target`} checked={local} onChange={() => { setLocal(true) }} />{t('native.target.local')}</label>
        <label><input type="radio" name={`${id}-target`} checked={!local} onChange={() => { setLocal(false) }} />{t('native.target.remote')}</label>
      </fieldset>
      {localStatus?.capture != null && contribution?.value?.capture != null
        && <p className={css.hint}>{t('native.share.parallel')}</p>}
      {orphanLocal !== null && <div className={css.form}>
        <p className={css.hint}>{t('native.local.orphanHint')}</p>
        <Button disabled={!ready} onClick={() => { void act({ kind: 'leave', expectedBindingId: orphanLocal.id }) }}>
          {t('native.local.clearPermission')}
        </Button>
      </div>}
      {local ? <NativeLocalContributionPanel agentId={runtime.sessionId} entry={localContribution} t={t}
        tasks={tasks.tasks.filter(task => task.origin.kind === 'root' && task.ownerNodeId === participants.nodeId)}
        receivingElsewhere={bound !== null && bound.kind !== 'local-task-scope' && state?.mode !== 'left'} scope={snapshot} actScope={act}
        catalogReady={snapshot.phase === 'ready' && tasks.read && participants.read && tasks.error === undefined && participants.error === undefined}
        readNativeLocalContribution={readNativeLocalContribution} checkoutNativeLocalTask={checkoutNativeLocalTask}
        requestNativeLocalContribution={requestNativeLocalContribution} stopNativeLocalContribution={stopNativeLocalContribution} /> : <>
        <p className={css.state} role="status">{state?.binding?.kind === 'local-task' ? t('native.mode.left') : label}</p>
        {state?.binding?.kind !== 'local-task' && state?.pauseReason != null && <p className={css.hint}>{t(`native.pause.${state.pauseReason}`)}</p>}
        {state !== undefined && state.binding?.kind !== 'local-task' && <p className={css.budget}>{state.automatic === null
          ? t('native.used', { used: state.usedBudget })
          : t('native.budget', { used: state.usedBudget, limit: state.automatic.activationLimit, steps: state.automatic.maxStepsPerTurn })}</p>}
        {observation !== null && (observation.eligibility !== 'eligible'
          ? <p className={css.notice}>{t(`native.eligibility.${observation.eligibility}`)}</p>
          : observation.localTask !== null && <div className={css.hint}>
            <p>{t('native.local.retainedTask', { task: tasks.tasks.find(task => task.id === observation.localTask?.taskId)?.objective ?? observation.localTask.taskId })}</p>
            <p>{t('native.local.scopeAdded')}</p>
          </div>)}
        {snapshot.phase === 'unavailable' && <p className={css.hint}>{t('native.unavailable')}</p>}
        {terminal && <p className={css.notice}>{t(`native.subscription.${observation.subscriptionState}`)}</p>}
        {bound !== null && <>
          <dl className={css.details}><dt>{t('native.task')}</dt><dd>{bound.invitation.taskId}</dd>
            <dt>{t('native.owner')}</dt><dd>{bound.invitation.ownerPeerId}</dd>
            <dt>{t('native.responsibility')}</dt><dd>{bound.invitation.responsibility}</dd></dl>
          {state?.automatic !== null && state?.automatic !== undefined && <p className={css.goal}>{t('native.currentGoal', { goal: state.automatic.goal })}</p>}
          {bound.kind === 'local-task-scope' && bound.retainedLocal.automatic !== null
            && <p className={css.hint}>{t('native.local.retainedPolicy', { goal: bound.retainedLocal.automatic.goal })}</p>}
          <p className={css.hint}>{t('native.receiving')}</p>
          <div className={css.actions}>
            {mode === 'paused' && !terminal && state?.automatic != null && state.automatic.activationLimit > state.usedBudget
              && <Button disabled={!editable} onClick={() => {
                if (state.automatic !== null) void act({ kind: 'resume', expectedBindingId: bound.id, automatic: state.automatic })
              }}>{t('native.resumeRemaining', { count: state.automatic.activationLimit - state.usedBudget })}</Button>}
            {mode === 'enabled' && <Button disabled={!ready} onClick={() => { void act({ kind: 'pause', expectedBindingId: bound.id }) }}>{t('native.pause')}</Button>}
            <Button disabled={!ready} onClick={() => { void act({ kind: 'leave', expectedBindingId: bound.id }) }}>{t('native.leave')}</Button>
          </div>
          <p className={css.hint}>{t('native.pauseHint')}</p>
          {!terminal && mode !== 'left' && observation !== null && observation.eligibility !== 'not-live' && <NativeReadRoute
            key={`${bound.id}/${bound.invitation.ownerAddress}/${observation.readStateSeq}`}
            current={bound.invitation.ownerAddress} ready={ready} t={t} update={ownerAddress => act({ kind: 'updateRoute',
              request: { expectedBindingId: bound.id, expectedReadStateSeq: observation.readStateSeq, ownerAddress } })} />}
        </>}
        {(!bound || (mode !== 'enabled' && !terminal)) && <form className={css.form} onSubmit={(event) => {
          event.preventDefault()
          if (!editable) return
          if (bound !== null) {
            if (automatic && policy !== undefined) void act({ kind: 'resume', expectedBindingId: bound.id, automatic: policy })
          } else if (invitation !== undefined) {
            const permission = automatic ? policy : null
            if (permission !== undefined) void act({ kind: 'bind', request: { invitation, expectedBindingId, automatic: permission,
              ...(observation.localTask !== null ? { localTask: observation.localTask } : {}) } })
          }
        }}>
          {!bound && <>
            <label className={css.field} htmlFor={`${id}-invitation`}>{t('native.invitation')}
              <textarea id={`${id}-invitation`} rows={4} value={invitationText} onChange={(event) => { setInvitationText(event.target.value); setAutomaticSelection(null); setSuccess(false) }} /></label>
            {invitationText.trim() !== '' && invitation === undefined && <p className={css.notice}>{t('native.invalidInvitation')}</p>}
            {invitation !== undefined && <dl className={css.details}><dt>{t('native.task')}</dt><dd>{invitation.taskId}</dd>
              <dt>{t('native.owner')}</dt><dd>{invitation.ownerPeerId}</dd><dt>{t('native.responsibility')}</dt><dd>{invitation.responsibility}</dd>
              <dt>{t('native.expires')}</dt><dd>{new Date(invitation.expiresAt).toLocaleString()}</dd></dl>}
          </>}
          <fieldset className={css.modes}><legend>{t('native.permission')}</legend>
            {!bound && <label><input type="radio" name={`${id}-mode`} checked={!automatic} onChange={() => { setAutomaticSelection(null) }} />{t('native.passive')}</label>}
            <label><input type="radio" name={`${id}-mode`} checked={automatic} onChange={() => { setAutomaticSelection(automaticKey) }} />{t('native.automatic')}</label>
          </fieldset>
          <p className={css.hint}>{t(automatic ? 'native.automaticHint' : 'native.passiveHint')}</p>
          {automatic && <NativeAutomaticPermission id={id} draft={{ goal, extra, steps, interval }}
            used={state?.usedBudget ?? 0} disabled={!editable} t={t} change={(draft) => {
              setGoal(draft.goal); setExtra(draft.extra); setSteps(draft.steps); setInterval(draft.interval)
            }} />}
          <Button type="submit" variant="primary" disabled={!editable || (bound === null && invitation === undefined) || ((automatic || bound !== null) && (!automatic || policy === undefined))}>
            {bound === null ? t('native.bind') : t('native.resume')}
          </Button>
        </form>}
        {success && snapshot.phase === 'ready' && state?.binding?.kind !== 'local-task' && <p className={css.hint}>{t('native.saved')}</p>}
        <NativeContributionPanel agentId={runtime.sessionId} entry={contribution} scope={snapshot} t={t}
          readNativeContribution={readNativeContribution} requestNativeContribution={requestNativeContribution}
          stopNativeContribution={stopNativeContribution} leaveNativeJoin={leaveNativeJoin}
          previewNativeContribution={previewNativeContribution} probeNativeContribution={probeNativeContribution}
          recoverNativeContributionRoute={recoverNativeContributionRoute} />
      </>}
      <NativeScopeActivity snapshot={snapshot} local={local} t={t} />
      {snapshot.issue !== null && <p ref={error} tabIndex={-1} className={css.notice} role="alert">{t(issueKey(snapshot.issue))}</p>}
      <div className={css.footer}><Button disabled={snapshot.pending} size="sm" onClick={refreshNativeScope}>{t('native.refresh')}</Button>
        <Button size="sm" onClick={() => { runtime.selectView('trajectory'); close() }}>{t('native.sources')}</Button></div>
    </section>, document.body)}
  </div>
}
