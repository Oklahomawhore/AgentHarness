/** One observed session's explicit local capture permit and independent owner approval. */
import { useEffect, useId, useRef, useState } from 'react'
import type {
  ClaudeScopeContributionDetail, ClaudeScopeSessionSummary, ClaudeScopeSessionKey,
  ClaudeScopePrepareContributionRequest, ClaudeScopeActivateContributionRequest, ClaudeScopeContributionLeaveRequest,
  ClaudeScopeRequestContributionRequest, ClaudeScopeContributionSource, ScopeContributionEntry,
  ScopeContributionTransfer, ScopeContributionInvitation, ScopeContributionEntryProbeRequest, ScopeContributionEntryProbeResult,
  ClaudeScopeLeaveJointRequest, ClaudeScopeRecoverJointRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContributionEntry } from './contribution-directory.ts'
import { contributionErrorKey, ContributionGrantSummary, ContributionSourceSummary, ContributionTransferText } from './contribution-ui.tsx'
import { ClaudeJointControls } from './ClaudeJointControls.tsx'
import css from './ClaudeScopePanel.module.css'

function sameInvitation(left: ScopeContributionInvitation, right: ScopeContributionInvitation): boolean {
  const a = left.grant
  const b = right.grant
  return left.ownerAddress === right.ownerAddress
    && a.taskId === b.taskId && a.grantId === b.grantId && a.generation === b.generation
    && a.ownerPeerId === b.ownerPeerId && a.contributorPeerId === b.contributorPeerId
    && a.captureId === b.captureId && a.captureGeneration === b.captureGeneration
    && a.source.name === b.source.name
    && (a.source.kind === 'tool-observations' ? b.source.kind === 'tool-observations' && a.source.tools.length === b.source.tools.length
      && a.source.tools.every(tool => b.source.kind === 'tool-observations' && b.source.tools.includes(tool))
      : b.source.kind !== 'tool-observations' && a.source.method === b.source.method && a.source.path === b.source.path)
    && a.expiresAt === b.expiresAt && a.maxSamples === b.maxSamples && a.maxSampleBytes === b.maxSampleBytes
}

/** Source mutations are settled by the apply-owned directory and then reread. */
export interface SourceContributionActions {
  readonly readContribution: (sessionKey: ClaudeScopeSessionKey) => void
  readonly requestContribution: (request: ClaudeScopeRequestContributionRequest) => Promise<void>
  readonly prepareContribution: (request: ClaudeScopePrepareContributionRequest) => Promise<void>
  readonly activateContribution: (request: ClaudeScopeActivateContributionRequest) => Promise<void>
  readonly stopContribution: (request: ClaudeScopeContributionLeaveRequest) => Promise<void>
  readonly leaveJointContribution: (request: ClaudeScopeLeaveJointRequest) => Promise<void>
  readonly recoverJointContribution: (request: ClaudeScopeRecoverJointRequest) => Promise<void>
  readonly probeContributionEntry: (request: ScopeContributionEntryProbeRequest) => Promise<ScopeContributionEntryProbeResult>
  readonly previewContributionText: (text: string) => Promise<ScopeContributionTransfer>
}

/** Render an exact selected source session, independent of any local Task.
 * @param props - source identity, authoritative detail observation and management callbacks.
 * @returns online application, manual recovery and independent stop controls.
 */
export function SourceContributionPanel({ session, entry, readContribution, requestContribution, prepareContribution, activateContribution,
  stopContribution, leaveJointContribution, recoverJointContribution, probeContributionEntry, previewContributionText, t,
}: SourceContributionActions & PropsLocale<'emergenceCenter'> & {
  session: ClaudeScopeSessionSummary
  entry: ContributionEntry<ClaudeScopeContributionDetail> | undefined
}) {
  const id = useId()
  const previewRevision = useRef(0)
  const [roots, setRoots] = useState(session.cwd ?? '')
  const [sourceKind, setSourceKind] = useState<'tool-observations' | 'openapi'>('tool-observations')
  const [filePath, setFilePath] = useState('')
  const [name, setName] = useState('')
  const [method, setMethod] = useState<'post' | 'put' | 'patch'>('post')
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [applicationText, setApplicationText] = useState('')
  const [applicationEntry, setApplicationEntry] = useState<ScopeContributionEntry>()
  const [hours, setHours] = useState('')
  const [samples, setSamples] = useState('')
  const [bytes, setBytes] = useState('')
  const [readConsent, setReadConsent] = useState<{ entry: ScopeContributionEntry; revision: number } | null>(null)
  const [collectionConsent, setCollectionConsent] = useState<string | null>(null)
  const [probe, setProbe] = useState<ScopeContributionEntryProbeResult['status']>()
  const [preview, setPreview] = useState<ScopeContributionInvitation>()
  const [previewing, setPreviewing] = useState(false)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    readContribution(session.sessionKey)
    return () => { previewRevision.current += 1 }
  }, [session.sessionKey, readContribution])
  const detail = entry?.value
  const capture = detail?.capture
  const selected = detail?.session ?? session
  useEffect(() => {
    previewRevision.current += 1; setPreview(undefined); setApplicationEntry(undefined); setInvalid(false); setPreviewing(false)
  }, [capture?.selection.captureId, capture?.selection.captureGeneration])
  useEffect(() => {
    if (entry?.status === 'ready' && !entry.pending && selected.contributionState === 'active'
      && preview !== undefined && capture?.invitation != null && sameInvitation(preview, capture.invitation)) {
      setPreview(undefined)
    }
  }, [entry?.status, entry?.pending, selected.contributionState, preview, capture?.invitation])
  const busy = entry?.pending === true || entry?.status !== 'ready'
  const ending = selected.contributionState === 'withdrawal-pending'
  const application = capture?.application
  const invitation = preview ?? capture?.invitation ?? undefined
  const parsedRoots = [...new Set(roots.split('\n').map(value => value.trim()).filter(Boolean))]
  const permissionValid = [hours, samples, bytes].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)
  const sourceValid = parsedRoots.length > 0 && (sourceKind === 'tool-observations' || !!filePath.trim() && !!name.trim() && !!path.trim())
  const jointEntry = applicationEntry?.kind === 'scope-join-entry' || applicationEntry?.kind === 'scope-group-entry'
  const joint = selected.joint
  const jointOwnsCapture = joint !== undefined && capture != null
    && joint.capture.captureId === capture.selection.captureId
    && joint.capture.captureGeneration === capture.selection.captureGeneration
  const pendingJoin = joint !== undefined && (joint.cleanupPending || !['active', 'ended', 'superseded'].includes(joint.state))
  const canReceive = !selected.ended && selected.taskId === undefined && selected.receiveSubscriptionId === undefined
    && (joint === undefined || !joint.cleanupPending && (joint.state === 'ended' || joint.state === 'superseded'))
  const readConfirmed = readConsent !== null && readConsent.entry === applicationEntry
    && readConsent.revision === selected.readRevision && canReceive
  const collectionKey = JSON.stringify([applicationEntry, parsedRoots, hours, samples, bytes])
  const collectionConfirmed = collectionConsent === collectionKey
  const jointConfirmed = !jointEntry || (readConfirmed && collectionConfirmed)
  const source: ClaudeScopeContributionSource = sourceKind === 'tool-observations'
    ? { kind: 'tool-observations', tools: ['Write', 'Edit'] }
    : { name: name.trim(), filePath: filePath.trim(), method, path: path.trim() }
  const verifyApplication = async (): Promise<void> => {
    const revision = ++previewRevision.current
    setPreviewing(true); setInvalid(false); setApplicationEntry(undefined); setReadConsent(null); setCollectionConsent(null)
    setProbe(undefined)
    try {
      const result = await previewContributionText(applicationText)
      if (revision !== previewRevision.current) return
      if (result.kind === 'openapi-contribution-entry' || result.kind === 'contribution-entry'
        || result.kind === 'scope-join-entry' || result.kind === 'scope-group-entry') {
        if ((result.kind === 'scope-join-entry' || result.kind === 'scope-group-entry') && capture === null) {
          const checked = await probeContributionEntry({ entry: result }).catch(() => ({ status: 'unavailable' as const }))
          if (revision !== previewRevision.current) return
          setProbe(checked.status)
          if (checked.status !== 'ready') return
        }
        setApplicationEntry(result)
        setSourceKind(result.kind === 'openapi-contribution-entry' ? 'openapi' : result.sourceKind)
      }
      else setInvalid(true)
    } catch { if (revision === previewRevision.current) setInvalid(true) }
    finally { if (revision === previewRevision.current) setPreviewing(false) }
  }
  const verify = async (): Promise<void> => {
    const revision = ++previewRevision.current
    setPreviewing(true); setInvalid(false); setPreview(undefined)
    try {
      const result = await previewContributionText(text)
      if (revision !== previewRevision.current) return
      if (result.kind === 'openapi-contribution' || result.kind === 'tool-contribution') setPreview(result)
      else setInvalid(true)
    } catch { if (revision === previewRevision.current) setInvalid(true) }
    finally { if (revision === previewRevision.current) setPreviewing(false) }
  }
  return <section data-claude-contribution className={css.section} aria-labelledby={`${id}-title`}>
    <header className={css.header}><h3 id={`${id}-title`}>{t('contribution.sourceTitle')}</h3>
      <Button size="sm" variant="ghost" disabled={entry?.pending} onClick={() => { readContribution(session.sessionKey) }}>{t('contribution.refresh')}</Button>
    </header>
    <p className={css.hint}>{t('contribution.sourceHint')}</p>
    {entry?.status === 'loading' && <p role="status" className={css.hint}>{t('contribution.loading')}</p>}
    {entry?.status === 'error' && <p role="alert" className={css.error}>{t('contribution.loadFailed')}</p>}
    {entry?.status === 'ready' && <p role="status" className={css.notice}>{t(selected.contributionState === 'active' ? 'contribution.active'
      : application != null ? `contribution.application.${application.state}` : ending ? 'contribution.ending' : capture ? 'contribution.prepared' : 'contribution.stopped')}</p>}
    {joint !== undefined && <ClaudeJointControls key={`${selected.sessionKey}/${joint.id}/${selected.readRevision}`}
      session={selected} joint={joint} ready={!busy} leave={leaveJointContribution} recover={recoverJointContribution} t={t} />}
    {capture === null && !pendingJoin && !selected.ended && selected.taskId === undefined && selected.sharingState !== 'withdrawal-pending' && <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (applicationEntry === undefined || !permissionValid || !sourceValid || !jointConfirmed) return
      void requestContribution({ sessionKey: session.sessionKey, expectedCapture: null, roots: parsedRoots,
        source, entry: applicationEntry,
        ...(jointEntry && readConsent !== null ? { receive: { expectedReadRevision: readConsent.revision } } : {}),
        limits: { expiresAt: Date.now() + Number(hours) * 3600000, maxSamples: Number(samples), maxSampleBytes: Number(bytes) } })
    }}>
      <label className={css.field} htmlFor={`${id}-entry`}>{t('contribution.application.paste')}<textarea id={`${id}-entry`} rows={3} value={applicationText} disabled={busy || previewing} onChange={(event) => {
        previewRevision.current += 1; setApplicationText(event.target.value); setApplicationEntry(undefined); setInvalid(false)
        setReadConsent(null); setCollectionConsent(null); setProbe(undefined)
      }} /></label>
      <Button type="button" variant="outline" disabled={busy || previewing || !applicationText.trim()} onClick={() => { void verifyApplication() }}>{t('contribution.application.verify')}</Button>
      {probe !== undefined && <p role={probe === 'ready' ? 'status' : 'alert'} className={css.notice}>{t(`native.share.probe.${probe}`)}</p>}
      {applicationEntry !== undefined && <dl className={css.permission}>
        <dt>{t('contribution.owner')}</dt><dd>{applicationEntry.ownerPeerId}</dd>
        <dt>{t('contribution.task')}</dt><dd>{applicationEntry.taskId}</dd>
        <dt>{t('contribution.application.entryExpires')}</dt><dd>{new Date(applicationEntry.expiresAt).toLocaleString()}</dd>
      </dl>}
      <label className={css.field} htmlFor={`${id}-source-kind`}>{t('contribution.sourceKind')}<select id={`${id}-source-kind`} value={sourceKind} disabled={busy || applicationEntry !== undefined} onChange={(event) => { setSourceKind(event.target.value as typeof sourceKind) }}>
        <option value="tool-observations">{t('contribution.toolObservations')}</option><option value="openapi">{t('contribution.openApi')}</option>
      </select></label>
      {sourceKind === 'openapi' && <>
        <label className={css.field} htmlFor={`${id}-file`}>{t('contribution.file')}<Input id={`${id}-file`} required value={filePath} disabled={busy} onChange={(event) => { setFilePath(event.target.value) }} /></label>
        <label className={css.field} htmlFor={`${id}-name`}>{t('contribution.sourceName')}<Input id={`${id}-name`} required value={name} disabled={busy} onChange={(event) => { setName(event.target.value) }} /></label>
        <label className={css.field} htmlFor={`${id}-method`}>{t('contribution.method')}<select id={`${id}-method`} value={method} disabled={busy} onChange={(event) => { setMethod(event.target.value as typeof method) }}>{(['post', 'put', 'patch'] as const).map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
        <label className={css.field} htmlFor={`${id}-path`}>{t('contribution.apiPath')}<Input id={`${id}-path`} required value={path} disabled={busy} onChange={(event) => { setPath(event.target.value) }} /></label>
      </>}
      <label className={css.field} htmlFor={`${id}-roots`}>{t('contribution.roots')}<textarea id={`${id}-roots`} required rows={2} value={roots} disabled={busy} onChange={(event) => { setRoots(event.target.value) }} /></label>
      <p className={css.hint}>{t(sourceKind === 'tool-observations' ? 'contribution.toolPermit' : 'contribution.localPermit')}</p>
      <label className={css.field} htmlFor={`${id}-hours`}>{t('contribution.hours')}<Input id={`${id}-hours`} type="number" min="1" value={hours} disabled={busy} onChange={(event) => { setHours(event.target.value) }} /></label>
      <label className={css.field} htmlFor={`${id}-samples`}>{t('contribution.maxSamples')}<Input id={`${id}-samples`} type="number" min="1" value={samples} disabled={busy} onChange={(event) => { setSamples(event.target.value) }} /></label>
      <label className={css.field} htmlFor={`${id}-bytes`}>{t('contribution.maxBytes')}<Input id={`${id}-bytes`} type="number" min="1" value={bytes} disabled={busy} onChange={(event) => { setBytes(event.target.value) }} /></label>
      {jointEntry ? <div data-claude-joint-consent className={css.form}>
        <p className={css.hint}>{t('claude.joint.hint')}</p>
        {!canReceive && <p role="status" className={css.notice}>{t('claude.joint.conflict')}</p>}
        <label className={css.description}><input type="checkbox" checked={readConfirmed} disabled={busy || !canReceive}
          onChange={(event) => { setReadConsent(event.target.checked
            ? { entry: applicationEntry, revision: selected.readRevision } : null) }} />{t('claude.joint.readConsent')}</label>
        <label className={css.description}><input type="checkbox" checked={collectionConfirmed} disabled={busy}
          onChange={(event) => { setCollectionConsent(event.target.checked ? collectionKey : null) }} />{t('claude.joint.collectionConsent')}</label>
      </div> : <p className={css.hint}>{t('contribution.application.consent')}</p>}
      <Button type="submit" disabled={busy || previewing || applicationEntry === undefined || !permissionValid || !sourceValid || !jointConfirmed}>
        {t(jointEntry ? 'claude.joint.request' : 'contribution.application.request')}
      </Button>
      {!jointEntry && <details data-contribution-manual-source><summary>{t('contribution.application.manual')}</summary>
        <p className={css.hint}>{t('contribution.application.manualHint')}</p>
        <Button type="button" variant="outline" disabled={busy || !sourceValid} onClick={() => {
          void prepareContribution({ sessionKey: session.sessionKey, expectedCapture: null, roots: parsedRoots,
            source })
        }}>{t('contribution.prepare')}</Button>
      </details>}
    </form>}
    {capture != null && <>
      <dl className={css.permission}>
        {!('kind' in capture.source) && <><dt>{t('contribution.file')}</dt><dd>{capture.source.filePath}</dd></>}
        <ContributionSourceSummary source={capture.proposal.source} t={t} />
        <dt>{t('contribution.roots')}</dt><dd>{capture.roots.join('\n')}</dd>
      </dl>
      {!ending && !jointOwnsCapture && application == null && selected.contributionState === 'prepared' && <ContributionTransferText key={capture.proposalText} text={capture.proposalText} label={t('contribution.proposalText')} t={t} />}
      {application == null && !jointOwnsCapture && <details open={selected.contributionState === 'prepared' && capture.invitation === null}><summary>{t(capture.invitation === null ? 'contribution.reviewOwnerInvitation' : 'contribution.reconnect')}</summary><form className={css.form} onSubmit={(event) => { event.preventDefault(); void verify() }}>
        <label className={css.field} htmlFor={`${id}-invitation`}>{t('contribution.pasteInvitation')}<textarea id={`${id}-invitation`} value={text} required rows={3} disabled={busy || previewing} onChange={(event) => {
          previewRevision.current += 1; setText(event.target.value); setPreview(undefined); setInvalid(false)
        }} /></label>
        <Button type="submit" variant="outline" disabled={busy || previewing || !text.trim()}>{t('contribution.verifyInvitation')}</Button>
      </form></details>}
      {application != null && <>
        <dl className={css.permission}>
          <dt>{t('contribution.owner')}</dt><dd>{application.entry.ownerPeerId}</dd>
          <dt>{t('contribution.task')}</dt><dd>{application.entry.taskId}</dd>
          <dt>{t('contribution.expires')}</dt><dd>{new Date(application.limits.expiresAt).toLocaleString()}</dd>
          <dt>{t('contribution.maxSamples')}</dt><dd>{application.limits.maxSamples}</dd>
          <dt>{t('contribution.maxBytes')}</dt><dd>{application.limits.maxSampleBytes}</dd>
        </dl>
        <p className={css.hint}>{t('contribution.application.background')}</p>
        {!jointOwnsCapture && <details><summary>{t('contribution.application.reconnect')}</summary>
          <label className={css.field} htmlFor={`${id}-entry-reconnect`}>{t('contribution.application.paste')}<textarea id={`${id}-entry-reconnect`} rows={3} value={applicationText} disabled={busy || previewing} onChange={(event) => {
            previewRevision.current += 1; setApplicationText(event.target.value); setApplicationEntry(undefined); setInvalid(false)
            setReadConsent(null); setCollectionConsent(null); setProbe(undefined)
          }} /></label>
          <Button variant="outline" disabled={busy || previewing || !applicationText.trim()} onClick={() => { void verifyApplication() }}>{t('contribution.application.verify')}</Button>
          {applicationEntry !== undefined && <><p className={css.path}>{applicationEntry.ownerAddress}</p>
            <Button disabled={busy || previewing} onClick={() => {
              void requestContribution({ sessionKey: session.sessionKey, expectedCapture: capture.selection,
                roots: capture.roots, source: capture.source, entry: applicationEntry, limits: application.limits })
            }}>{t('contribution.application.retryAddress')}</Button></>}
        </details>}
      </>}
      {invitation !== undefined && <>
        <ContributionGrantSummary grant={invitation.grant} t={t} /><p className={css.path}>{invitation.ownerAddress}</p>
      </>}
      <p className={css.hint}>{t(ending ? 'contribution.endingHint' : 'contribution.activationHint')}</p>
      {jointOwnsCapture && <p className={css.hint}>{t(joint.state === 'active'
        ? 'claude.joint.stopActiveHint' : 'claude.joint.stopPendingHint')}</p>}
      <div className={css.actions}>
        {application == null && !jointOwnsCapture && !ending && (selected.contributionState === 'prepared' || preview !== undefined) && invitation !== undefined && !selected.ended && <Button disabled={busy || previewing} onClick={() => {
          void activateContribution({ sessionKey: session.sessionKey, expectedCapture: capture.selection, invitation })
        }}>{t(selected.contributionState === 'active' ? 'contribution.confirmReconnect' : 'contribution.activate')}</Button>}
        <Button variant="outline" disabled={busy} onClick={() => { void stopContribution({ sessionKey: session.sessionKey, expectedCapture: capture.selection, ...(ending && capture.invitation !== null && preview !== undefined ? { invitation: preview } : {}) }) }}>{t(ending && preview !== undefined ? 'contribution.retryWithAddress' : ending ? 'contribution.retryEnd' : 'contribution.stop')}</Button>
      </div>
    </>}
    {selected.contributionIssue !== undefined && <p role="status" className={css.notice}>{t(`claude.issue.${selected.contributionIssue}`)}</p>}
    {invalid && <p role="alert" className={css.error}>{t('contribution.error.text')}</p>}
    {entry?.error !== undefined && <p role="alert" className={css.error}>{t(contributionErrorKey(entry.error))}</p>}
  </section>
}
