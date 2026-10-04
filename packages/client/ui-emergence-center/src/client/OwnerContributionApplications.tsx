/** Owner-issued application entries and consent-limited online approval. */
import { useEffect, useId, useRef, useState } from 'react'
import type { DevelopmentTaskId, ScopeContributionApplications, ScopeContributionEntryRequest,
  ScopeContributionEntryRecoverRequest, ScopeContributionEntryResult, ScopeContributionApplicationApprovalRequest,
  ScopeContributionApplicationRejectRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { ContributionTransferText, ContributionSourceSummary } from './contribution-ui.tsx'
import css from './ClaudeScopePanel.module.css'

/** Online approval operations remain owned by the authoritative management directory. */
export interface OwnerApplicationActions {
  readonly createContributionEntry: (request: ScopeContributionEntryRequest) => Promise<void>
  readonly recoverContributionEntry: (
    taskId: DevelopmentTaskId, request: ScopeContributionEntryRecoverRequest,
  ) => Promise<ScopeContributionEntryResult | undefined>
  readonly approveContributionApplication: (
    taskId: DevelopmentTaskId, request: ScopeContributionApplicationApprovalRequest,
  ) => Promise<void>
  readonly rejectContributionApplication: (taskId: DevelopmentTaskId, request: ScopeContributionApplicationRejectRequest) => Promise<void>
}

function JoinApproval({ pending, approve, t }: PropsLocale<'emergenceCenter'> & {
  pending: boolean
  approve: (responsibility: string) => void
}) {
  const id = useId()
  const [responsibility, setResponsibility] = useState('')
  return <form className={css.form} onSubmit={(event) => {
    event.preventDefault()
    if (!pending && responsibility.trim()) approve(responsibility.trim())
  }}>
    <p className={css.hint}>{t('contribution.join.approvalHint')}</p>
    <label className={css.field} htmlFor={id}>{t('contribution.join.responsibility')}
      <Input id={id} required value={responsibility} disabled={pending}
        onChange={(event) => { setResponsibility(event.target.value) }} /></label>
    <p className={css.hint}>{t('contribution.join.responsibilityHint')}</p>
    <Button type="submit" disabled={pending || !responsibility.trim()}>{t('contribution.join.approve')}</Button>
  </form>
}

/** Show one entry per capture and let the owner approve only the displayed source consent.
 * @param props - selected owner Task, committed application observations and management callbacks.
 * @returns entry creation, original-entry recovery and pending application decisions.
 */
export function OwnerContributionApplications({ taskId, applications, ownerAddress, pending,
  createContributionEntry, recoverContributionEntry, approveContributionApplication, rejectContributionApplication, t,
}: OwnerApplicationActions & PropsLocale<'emergenceCenter'> & {
  taskId: DevelopmentTaskId
  applications: ScopeContributionApplications | undefined
  ownerAddress: string
  pending: boolean
}) {
  const id = useId()
  const generation = useRef(0)
  const [hours, setHours] = useState('')
  const [participation, setParticipation] = useState<'join' | 'contribution'>('join')
  const [sourceKind, setSourceKind] = useState<'tool-observations' | 'openapi'>('tool-observations')
  const [recovered, setRecovered] = useState<ScopeContributionEntryResult>()
  useEffect(() => () => { generation.current += 1 }, [taskId])
  const validHours = Number.isSafeInteger(Number(hours)) && Number(hours) > 0
  return <section data-contribution-applications>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (!validHours || !ownerAddress) return
      void createContributionEntry({ taskId, ownerAddress, sourceKind: participation === 'join' ? 'tool-observations' : sourceKind,
        expiresAt: Date.now() + Number(hours) * 3600000, ...(participation === 'join' ? { participation: 'join' } : {}) })
    }}>
      <label className={css.field} htmlFor={`${id}-participation`}>{t('contribution.join.purpose')}<select id={`${id}-participation`} value={participation} disabled={pending} onChange={(event) => { setParticipation(event.target.value as typeof participation) }}>
        <option value="join">{t('contribution.join.create')}</option><option value="contribution">{t('contribution.join.contributionOnly')}</option>
      </select></label>
      {participation === 'contribution' && <label className={css.field} htmlFor={`${id}-source-kind`}>{t('contribution.sourceKind')}<select id={`${id}-source-kind`} value={sourceKind} disabled={pending} onChange={(event) => { setSourceKind(event.target.value as typeof sourceKind) }}>
        <option value="tool-observations">{t('contribution.toolObservations')}</option><option value="openapi">{t('contribution.openApi')}</option>
      </select></label>}
      <label className={css.field} htmlFor={`${id}-hours`}>{t('contribution.application.entryHours')}<Input id={`${id}-hours`} type="number" min="1" required value={hours} disabled={pending} onChange={(event) => { setHours(event.target.value) }} /></label>
      <p className={css.hint}>{t(participation === 'join' ? 'contribution.join.entryHint' : 'contribution.application.entryHint')}</p>
      <Button type="submit" disabled={pending || !ownerAddress || !validHours}>{t(participation === 'join' ? 'contribution.join.create' : 'contribution.application.create')}</Button>
    </form>
    {applications?.entries.map((item) => {
      const proposal = item.proposal
      const limits = item.limits
      const joint = item.entry.kind === 'scope-join-entry'
      return <div key={item.entry.entryId} className={css.record}>
        <p role="status">{t(`contribution.application.owner.${item.result.status}`)}</p>
        {joint && <p className={css.hint}>{t('contribution.join.permissions')}</p>}
        {joint && (item.result.status === 'approved' || item.result.status === 'ended') && item.result.readState !== undefined
          && <p role="status" data-join-read-permission>{t(`contribution.join.read.${item.result.readState}`)}</p>}
        <details open={item.result.status === 'open'}><summary>{t('contribution.application.entryText')}</summary>
          <ContributionTransferText text={recovered?.entry.entryId === item.entry.entryId ? recovered.text : item.text} label={t('contribution.application.entryText')} t={t} />
        </details>
        <p className={css.hint}>{t('contribution.application.entryExpires')}: {new Date(item.entry.expiresAt).toLocaleString()}</p>
        {proposal !== null && limits !== null && <dl className={css.permission}>
          <dt>{t('contribution.sourcePeer')}</dt><dd>{proposal.contributorPeerId}</dd>
          <ContributionSourceSummary source={proposal.source} t={t} />
          <dt>{t('contribution.expires')}</dt><dd>{new Date(limits.expiresAt).toLocaleString()}</dd>
          <dt>{t('contribution.maxSamples')}</dt><dd>{limits.maxSamples}</dd>
          <dt>{t('contribution.maxBytes')}</dt><dd>{limits.maxSampleBytes}</dd>
        </dl>}
        <div className={css.actions}>
          {item.result.status === 'pending' && proposal !== null && limits !== null && (joint
            ? <JoinApproval key={`${item.entry.entryId}/${proposal.captureId}/${proposal.captureGeneration}`} pending={pending || !ownerAddress} t={t}
              approve={(responsibility) => { void approveContributionApplication(taskId, { entryId: item.entry.entryId,
                expectedProposal: proposal, limits, ownerAddress, read: { responsibility } }) }} />
            : <Button disabled={pending || !ownerAddress} onClick={() => {
              void approveContributionApplication(taskId, { entryId: item.entry.entryId, expectedProposal: proposal, limits, ownerAddress })
            }}>{t('contribution.application.approve')}</Button>)}
          {(item.result.status === 'open' || item.result.status === 'pending') && <Button variant="ghost" disabled={pending} onClick={() => {
            void rejectContributionApplication(taskId, { entryId: item.entry.entryId, expectedProposal: proposal })
          }}>{t('contribution.application.reject')}</Button>}
          <Button variant="outline" disabled={pending || !ownerAddress} onClick={() => {
            const issued = generation.current
            void recoverContributionEntry(taskId, { entryId: item.entry.entryId, ownerAddress }).then((result) => {
              if (issued === generation.current && result !== undefined) setRecovered(result)
            })
          }}>{t('contribution.application.recover')}</Button>
        </div>
      </div>
    })}
  </section>
}
