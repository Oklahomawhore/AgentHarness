/** Explicit sharing permission for the current native Session. */
import { useEffect, useId, useRef, useState } from 'react'
import type {
  ScopeAgentContributionRequest, ScopeAgentContributionStatus, ScopeAgentContributionStopRequest, ScopeAgentContributionReceiving,
  ScopeContributionEntry, ScopeContributionTransfer, ScopeAgentContributionRecoverRouteRequest,
  ScopeContributionEntryProbeRequest, ScopeContributionEntryProbeResult, ScopeAgentLocalTaskTarget,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContributionEntry } from './contribution-directory.ts'
import { sameLocalTarget, type NativeScopeSnapshot } from './native-scopes.ts'
import { ContributionGrantSummary, contributionErrorKey } from './contribution-ui.tsx'
import type { EmergenceCenterKey } from './locales.ts'
import { NativeContributionRoute } from './NativeContributionRoute.tsx'
import { NativeContributionPermission } from './NativeContributionPermission.tsx'
import { automaticPolicy, NativeAutomaticPermission, type NativeAutomaticDraft } from './NativeAutomaticPermission.tsx'
import css from './NativeScopeAction.module.css'

/** Local management callbacks supplied by the apply-owned directory. */
export interface NativeContributionActions {
  readonly readNativeContribution: (agentId: SessionId) => void
  readonly recoverNativeContributionRoute: (request: ScopeAgentContributionRecoverRouteRequest) => Promise<void>
  readonly requestNativeContribution: (request: ScopeAgentContributionRequest) => Promise<void>
  readonly leaveNativeJoin: (request: ScopeAgentContributionStopRequest) => Promise<void>
  readonly stopNativeContribution: (request: ScopeAgentContributionStopRequest) => Promise<void>
  readonly previewNativeContribution: (text: string) => Promise<ScopeContributionTransfer>
  readonly probeNativeContribution: (request: ScopeContributionEntryProbeRequest) => Promise<ScopeContributionEntryProbeResult>
}

function issueKey(code: string): EmergenceCenterKey {
  switch (code) {
    case 'scope-agent-contribution/not-live': return 'native.share.notLive'
    case 'scope-agent-contribution/ineligible': return 'native.share.ineligible'
    case 'scope-agent-contribution/stale-route': case 'scope-agent-contribution/stale-capture': case 'scope-agent-contribution/superseded': return 'contribution.error.stale'
    case 'scope-agent-contribution/invalid-permission': return 'contribution.error.permission'
    case 'scope-agent-contribution/unavailable':
    case 'gateway/service-unavailable': case 'gateway/method-unavailable': return 'native.share.unavailable'
    default: return contributionErrorKey(code)
  }
}

function JoinReceiving({ receiving, intent, ready, leave, t }: PropsLocale<'emergenceCenter'> & {
  receiving: ScopeAgentContributionReceiving
  intent: 'adopt' | 'cancel-pending' | 'leave' | undefined
  ready: boolean
  leave: () => void
}) {
  const terminal = receiving.state === 'ended' || receiving.state === 'superseded'
  const confirming = intent !== 'adopt' && !terminal
  return <div data-native-join-status>
    <p role="status" className={css.state}>{t(confirming ? 'native.join.confirming' : `native.join.state.${receiving.state}`)}</p>
    {confirming && receiving.state === 'failed' && <p className={css.notice}>{t('native.join.retryHint')}</p>}
    {receiving.automatic === undefined ? <p className={css.hint}>{t('native.join.passiveHint')}</p> : <>
      <p className={css.hint}>{t('native.join.automaticCaptured', {
        goal: receiving.automatic.goal, limit: receiving.automatic.activationLimit,
      })}</p>
      <dl className={css.details}>
        <dt>{t('native.steps')}</dt><dd>{receiving.automatic.maxStepsPerTurn}</dd>
        <dt>{t('native.interval')}</dt><dd>{receiving.automatic.minIntervalMs / 1000}</dd>
      </dl>
    </>}
    {receiving.invitation !== null && <p className={css.hint}>{t('native.join.responsibility', { value: receiving.invitation.responsibility })}</p>}
    <Button disabled={!ready} onClick={leave}>{t('native.join.leave')}</Button>
    <p className={css.hint}>{t('native.join.leaveHint')}</p>
  </div>
}

function stopHint(state: ScopeAgentContributionReceiving['state']): EmergenceCenterKey {
  switch (state) {
    case 'active': return 'native.join.stopSharingHint'
    case 'waiting': case 'adopting': return 'native.join.stopPendingHint'
    case 'failed': return 'native.join.stopUncertainHint'
    case 'ended': case 'superseded': return 'native.join.stopSeparateHint'
  }
}

/**
 * Confirm file permission and joint receiving, with optional finite automatic work for the current unbound Session.
 * @param props - current Session, authoritative management observation, and actions.
 * @returns source permission form and recoverable pending state.
 */
export function NativeContributionPanel(props: NativeContributionActions & PropsLocale<'emergenceCenter'> & {
  agentId: SessionId
  scope: NativeScopeSnapshot
  entry: ContributionEntry<ScopeAgentContributionStatus> | undefined
}) {
  return <SessionContributionPanel key={props.agentId} {...props} />
}

function SessionContributionPanel({ agentId, entry, readNativeContribution, requestNativeContribution,
  stopNativeContribution, leaveNativeJoin, previewNativeContribution, probeNativeContribution,
  recoverNativeContributionRoute, scope, t,
}: Parameters<typeof NativeContributionPanel>[0]) {
  const id = useId()
  const previewRevision = useRef(0)
  const actionPending = useRef(false)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ScopeContributionEntry>()
  const [previewing, setPreviewing] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [probe, setProbe] = useState<ScopeContributionEntryProbeResult['status']>()
  const [roots, setRoots] = useState('')
  const [write, setWrite] = useState(false)
  const [edit, setEdit] = useState(false)
  const [hours, setHours] = useState('')
  const [samples, setSamples] = useState('')
  const [bytes, setBytes] = useState('')
  const [consent, setConsent] = useState(false)
  const [readConsent, setReadConsent] = useState<{
    entry: ScopeContributionEntry
    seq: SessionSeqCursor
    localTask: ScopeAgentLocalTaskTarget | null
  } | null>(null)
  const [automaticDraft, setAutomaticDraft] = useState<NativeAutomaticDraft>({ goal: '', extra: '', steps: '', interval: '' })
  const [automaticConsent, setAutomaticConsent] = useState<{
    entry: ScopeContributionEntry
    seq: SessionSeqCursor
    used: number
  } | null>(null)
  useEffect(() => {
    readNativeContribution(agentId)
    return () => { previewRevision.current++ }
  }, [agentId, readNativeContribution])
  const status = entry?.value
  const capture = status?.capture
  const continuation = status?.receivingContinuation
  const recoverable = capture ?? continuation
  const occupied = capture != null || continuation !== undefined
  useEffect(() => {
    if (!occupied) return
    previewRevision.current++
    setPreview(undefined); setProbe(undefined); setPreviewing(false); setReadConsent(null); setConsent(false); setAutomaticConsent(null)
  }, [occupied])
  const routeReadSeq = scope.observation?.eligibility === 'not-live' ? undefined : scope.observation?.readStateSeq
  const ready = entry?.status === 'ready' && !entry.pending
  const eligible = ready && status?.eligibility === 'eligible'
  const joint = preview?.kind === 'scope-join-entry' || preview?.kind === 'scope-group-entry'
  const observation = scope.observation
  const readState = observation?.eligibility === 'eligible' ? observation : null
  const canReceive = scope.phase === 'ready' && !scope.pending && readState !== null && readState.agentId === agentId
    && (readState.state.binding === null || (readState.localTask !== null && readState.state.binding.kind === 'local-task'))
    && readState.subscriptionState === 'unbound'
  const readConfirmed = readConsent !== null && readConsent.entry === preview && canReceive
    && readConsent.seq === readState.readStateSeq
    && (readConsent.localTask === null ? readState.localTask === null : sameLocalTarget(readState.localTask, readConsent.localTask))
  const used = readState?.state.usedBudget ?? 0
  const automaticConfirmed = automaticConsent !== null && readConfirmed && automaticConsent.entry === preview
    && automaticConsent.seq === readState.readStateSeq && automaticConsent.used === used
  const policy = automaticPolicy(automaticDraft, used)
  useEffect(() => {
    if (automaticConsent === null || (automaticConsent.entry === preview
      && automaticConsent.seq === readState?.readStateSeq && automaticConsent.used === used)) return
    setAutomaticConsent(null); setReadConsent(null)
  }, [automaticConsent, preview, readState?.readStateSeq, used])
  const selectedRoots = [...new Set(roots.split('\n').map(value => value.trim()).filter(Boolean))]
  const tools: ('write' | 'edit')[] = [...(write ? ['write' as const] : []), ...(edit ? ['edit' as const] : [])]
  const expiresAt = Date.now() + Number(hours) * 3_600_000
  const limitsValid = [hours, samples, bytes].every(value => value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) > 0)
    && Number.isSafeInteger(expiresAt)
  const canRequest = eligible && capture === null && continuation === undefined && consent && preview !== undefined && tools.length > 0
    && selectedRoots.length > 0 && limitsValid && !previewing && (!joint || (readConfirmed
      && (automaticConsent === null || (automaticConfirmed && policy !== undefined))))
  const verify = async (): Promise<void> => {
    const revision = ++previewRevision.current
    setPreviewing(true); setInvalid(false); setPreview(undefined); setProbe(undefined)
    setReadConsent(null); setConsent(false); setAutomaticConsent(null)
    let result: ScopeContributionTransfer
    try { result = await previewNativeContribution(text) }
    catch {
      if (revision === previewRevision.current) { setInvalid(true); setPreviewing(false) }
      return
    }
    if (revision !== previewRevision.current) return
    if ((result.kind !== 'contribution-entry' && result.kind !== 'scope-join-entry' && result.kind !== 'scope-group-entry') || result.sourceKind !== 'tool-observations') {
      setInvalid(true); setPreviewing(false); return
    }
    let checked: ScopeContributionEntryProbeResult
    try { checked = await probeNativeContribution({ entry: result }) }
    catch {
      if (revision === previewRevision.current) { setProbe('unavailable'); setPreviewing(false) }
      return
    }
    if (revision !== previewRevision.current) return
    setProbe(checked.status); setPreviewing(false)
    if (checked.status === 'ready') setPreview(result)
  }
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (actionPending.current) return
    actionPending.current = true
    try { await operation() } finally { actionPending.current = false }
  }
  const stateKey: EmergenceCenterKey = capture == null ? 'native.share.none'
    : capture.state === 'ending' ? 'contribution.ending'
      : capture.state === 'active' ? capture.collecting ? 'native.share.active' : 'native.share.paused'
        : capture.application === null ? 'contribution.prepared' : `contribution.application.${capture.application}`
  return <details data-native-contribution className={css.sharing}>
    <summary>{t('native.share.title')}</summary>
    <div className={css.form}>
      <p className={css.hint}>{t('native.share.hint')}</p>
      {entry?.status === 'loading' && <p role="status" className={css.hint}>{t('contribution.loading')}</p>}
      {entry?.status === 'error' && <p role="alert" className={css.notice}>{t(issueKey(entry.error ?? 'unknown'))}</p>}
      {ready && <p role="status" className={css.state}>{t(stateKey)}</p>}
      {status !== undefined && status.eligibility !== 'eligible' && <p className={css.hint}>{t(status.eligibility === 'not-live'
        ? 'native.share.notLive' : 'native.share.ineligible')}</p>}
      {capture === null && continuation === undefined && <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        if (!canRequest) return
        void perform(() => requestNativeContribution({ agentId, expectedCapture: null, entry: preview, roots: selectedRoots, tools,
          limits: { expiresAt, maxSamples: Number(samples), maxSampleBytes: Number(bytes) },
          ...(joint && readConsent !== null ? { receive: { expectedReadStateSeq: readConsent.seq,
            ...(readConsent.localTask === null ? {} : { localTask: readConsent.localTask }),
            ...(automaticConfirmed && policy !== undefined ? { automatic: policy } : {}) } } : {}) }))
      }}>
        <label className={css.field} htmlFor={`${id}-entry`}>{t('contribution.application.paste')}
          <textarea id={`${id}-entry`} rows={3} value={text} disabled={!eligible} onChange={(event) => {
            previewRevision.current++; setText(event.target.value); setPreview(undefined); setInvalid(false); setProbe(undefined)
            setPreviewing(false); setReadConsent(null); setConsent(false); setAutomaticConsent(null)
          }} /></label>
        <Button disabled={!eligible || previewing || !text.trim()} onClick={() => { void verify() }}>{t('native.share.verify')}</Button>
        {previewing && <p role="status" className={css.hint}>{t('native.share.verifying')}</p>}
        {probe !== undefined && <p role={probe === 'ready' ? 'status' : 'alert'} className={css.notice}>{t(`native.share.probe.${probe}`)}</p>}
        {invalid && <p role="alert" className={css.notice}>{t('native.share.invalidEntry')}</p>}
        {preview !== undefined && <>
          <dl className={css.details}>
            <dt>{t('contribution.owner')}</dt><dd>{preview.ownerPeerId}</dd><dt>{t('contribution.task')}</dt><dd>{preview.taskId}</dd>
            <dt>{t('contribution.application.entryExpires')}</dt><dd>{new Date(preview.expiresAt).toLocaleString()}</dd>
          </dl>
          {joint && <>
            <p className={css.hint}>{t('native.join.hint')}</p>
            {!canReceive && <p role="status" className={css.notice}>{t('native.join.unboundRequired')}</p>}
            <label className={css.consent}><input type="checkbox" checked={readConfirmed} disabled={!eligible || !canReceive}
              onChange={(event) => {
                setReadConsent(event.target.checked && readState !== null
                  ? { entry: preview, seq: readState.readStateSeq, localTask: readState.localTask } : null)
                setAutomaticConsent(null)
              }} />
            {t('native.join.readConsent')}</label>
          </>}
          <NativeContributionPermission id={id} draft={{ roots, write, edit, hours, samples, bytes, consent }}
            disabled={!eligible} consentKey="native.share.consent" t={t} change={(draft) => {
              setRoots(draft.roots); setWrite(draft.write); setEdit(draft.edit); setHours(draft.hours)
              setSamples(draft.samples); setBytes(draft.bytes); setConsent(draft.consent)
            }} />
          {joint && <div data-native-join-automatic className={css.form}>
            <label className={css.consent}><input type="checkbox" checked={automaticConfirmed} disabled={!eligible || !readConfirmed}
              onChange={(event) => {
                if (event.target.checked && readState?.localTask !== null && readState?.state.automatic != null) {
                  const goal = readState.state.automatic.goal
                  setAutomaticDraft(value => ({ ...value, goal: value.goal || goal }))
                }
                setAutomaticConsent(event.target.checked && readState !== null
                  ? { entry: preview, seq: readState.readStateSeq, used } : null)
              }} />{t('native.join.automaticConsent')}</label>
            {automaticConsent !== null && <>
              <NativeAutomaticPermission id={`${id}-join`} draft={automaticDraft} used={used}
                disabled={!eligible || !readConfirmed} change={setAutomaticDraft} t={t} />
              <p className={css.hint}>{t('native.automaticHint')}</p>
            </>}
          </div>}
          <Button type="submit" variant="primary" disabled={!canRequest}>{t(joint ? 'native.join.request' : 'native.share.request')}</Button>
        </>}
      </form>}
      {capture != null && <>
        <dl className={css.details}>
          <dt>{t('contribution.task')}</dt><dd>{capture.entry.taskId}</dd><dt>{t('contribution.owner')}</dt><dd>{capture.entry.ownerPeerId}</dd>
          {capture.entry.kind === 'scope-group-entry' && <>
            <dt>{t('contribution.group.capture')}</dt><dd>{capture.selection.captureId}</dd>
            <dt>{t('contribution.group.captureGeneration')}</dt><dd>{capture.selection.captureGeneration}</dd>
          </>}
          <dt>{t('contribution.roots')}</dt><dd>{capture.roots.join('\n')}</dd>
          <dt>{t('native.share.tools')}</dt><dd>{capture.tools.map(tool => t(tool === 'write' ? 'native.share.write' : 'native.share.edit')).join(', ')}</dd>
          <dt>{t('contribution.expires')}</dt><dd>{new Date(capture.limits.expiresAt).toLocaleString()}</dd>
          <dt>{t('contribution.maxSamples')}</dt><dd>{capture.limits.maxSamples}</dd>
          <dt>{t('contribution.maxBytes')}</dt><dd>{capture.limits.maxSampleBytes}</dd>
        </dl>
        {capture.receiving !== null && <JoinReceiving receiving={capture.receiving}
          intent={capture.receivingIntent ?? (capture.state === 'ending' ? undefined : 'adopt')} ready={ready} t={t}
          leave={() => { void perform(() => leaveNativeJoin({ agentId, expectedCapture: capture.selection })) }} />}
        {capture.invitation !== null && <details><summary>{t('native.share.approval')}</summary><ContributionGrantSummary grant={capture.invitation.grant} t={t} /></details>}
        <p className={css.hint}>{t('native.share.pending', { count: capture.pendingSamples })}</p>
        {capture.collectionIssue !== null && <p role="status" className={css.notice}>{t(`native.share.collection.${capture.collectionIssue}`)}</p>}
        {capture.issue !== null && <p className={css.notice}>{t(`native.share.issue.${capture.issue}`)}</p>}
        {capture.state === 'ending' && <p className={css.hint}>{t('native.share.endingHint')}</p>}
        {capture.receivingIntent !== 'leave' && <Button disabled={!ready} onClick={() => { void perform(() => stopNativeContribution({ agentId, expectedCapture: capture.selection })) }}>{t(capture.state === 'ending' ? 'native.share.retryStop'
          : capture.receiving?.state === 'waiting' || capture.receiving?.state === 'adopting' ? 'native.join.cancelPending' : 'native.share.stop')}</Button>}
        {capture.receiving !== null && capture.receivingIntent !== 'leave' && <p className={css.hint}>{t(capture.receivingIntent === 'cancel-pending'
          ? 'native.join.stopUncertainHint' : stopHint(capture.receiving.state))}</p>}
      </>}
      {capture === null && continuation !== undefined && <div data-native-join-continuation>
        <p role="status" className={css.hint}>{t('native.join.continuation')}</p>
        <JoinReceiving receiving={continuation.receiving} intent={continuation.intent} ready={ready} t={t}
          leave={() => { void perform(() => leaveNativeJoin({ agentId, expectedCapture: continuation.selection })) }} />
        {continuation.intent !== 'leave' && <Button disabled={!ready} onClick={() => {
          void perform(() => stopNativeContribution({ agentId, expectedCapture: continuation.selection }))
        }}>{t(continuation.intent === 'adopt' ? 'native.join.cancelRead' : 'native.join.retryCancel')}</Button>}
      </div>}
      {recoverable != null && <NativeContributionRoute
        key={`${agentId}/${recoverable.selection.captureId}/${recoverable.selection.captureGeneration}/${recoverable.entry.ownerAddress}/${recoverable.routeRevision}/${routeReadSeq ?? ''}`}
        agentId={agentId} current={recoverable} ready={ready && !scope.pending && ((recoverable.entry.kind !== 'scope-join-entry' && recoverable.entry.kind !== 'scope-group-entry') || scope.phase === 'ready')} t={t}
        {...((recoverable.entry.kind === 'scope-join-entry' || recoverable.entry.kind === 'scope-group-entry') && routeReadSeq !== undefined ? { receive: { expectedReadStateSeq: routeReadSeq } } : {})}
        preview={previewNativeContribution} recover={request => perform(() => recoverNativeContributionRoute(request))} />}
      {entry?.status !== 'error' && entry?.error !== undefined && <p role="alert" className={css.notice}>{t(issueKey(entry.error))}</p>}
      <Button size="sm" disabled={entry?.pending} onClick={() => { readNativeContribution(agentId) }}>{t('native.share.refresh')}</Button>
    </div>
  </details>
}
