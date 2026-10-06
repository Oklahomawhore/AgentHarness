/** Owner-issued application entries and consent-limited online approval. */
import { useEffect, useId, useRef, useState } from 'react'
import type { DevelopmentTaskId, ScopeContributionApplications, ScopeContributionEntryRequest,
  ScopeContributionEntryRecoverRequest, ScopeContributionEntryResult, ScopeContributionApplicationApprovalRequest,
  ScopeContributionApplicationRejectRequest, ScopeGroupEntryRequest, ScopeGroupEntrySelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { ContributionTransferText, ContributionSourceSummary } from './contribution-ui.tsx'
import type { OwnerGroupValue } from './owner-contributions.ts'
import css from './ClaudeScopePanel.module.css'

/** Online approval operations remain owned by the authoritative management directory. */
export interface OwnerApplicationActions {
  readonly createGroupEntry: (request: ScopeGroupEntryRequest) => Promise<void>
  readonly closeGroupEntry: (taskId: DevelopmentTaskId, request: ScopeGroupEntrySelection) => Promise<void>
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

/** Create single-use or reusable entries and approve each applicant’s displayed consent.
 * @param props - selected owner Task, committed application observations and management callbacks.
 * @returns entry creation, original-entry recovery and pending application decisions.
 */
export function OwnerContributionApplications({ taskId, applications, groups, ownerAddress, pending,
  createContributionEntry, createGroupEntry, closeGroupEntry, recoverContributionEntry,
  approveContributionApplication, rejectContributionApplication, t,
}: OwnerApplicationActions & PropsLocale<'emergenceCenter'> & {
  taskId: DevelopmentTaskId
  applications: ScopeContributionApplications | undefined
  groups: readonly OwnerGroupValue[] | undefined
  ownerAddress: string
  pending: boolean
}) {
  const id = useId()
  const generation = useRef(0)
  const [hours, setHours] = useState('')
  const [participation, setParticipation] = useState<'join' | 'contribution' | 'group'>('join')
  const [capacity, setCapacity] = useState('')
  const [sourceKind, setSourceKind] = useState<'tool-observations' | 'openapi'>('tool-observations')
  const [recovered, setRecovered] = useState<ScopeContributionEntryResult>()
  useEffect(() => () => { generation.current += 1 }, [taskId])
  const validHours = Number.isSafeInteger(Number(hours)) && Number(hours) > 0
  const validCapacity = Number.isSafeInteger(Number(capacity)) && Number(capacity) > 0
  const createLabel = participation === 'group' ? 'contribution.group.create'
    : participation === 'join' ? 'contribution.join.create' : 'contribution.application.create'
  const recover = (entryId: ScopeContributionEntryRecoverRequest['entryId']): void => {
    const issued = generation.current
    void recoverContributionEntry(taskId, { entryId, ownerAddress }).then((result) => {
      if (issued === generation.current && result !== undefined) setRecovered(result)
    })
  }
  return <section data-contribution-applications>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (!validHours || !ownerAddress) return
      if (participation === 'group') {
        if (validCapacity) void createGroupEntry({ taskId, ownerAddress,
          expiresAt: Date.now() + Number(hours) * 3600000, maxMembers: Number(capacity) })
        return
      }
      void createContributionEntry({ taskId, ownerAddress, sourceKind: participation === 'join' ? 'tool-observations' : sourceKind,
        expiresAt: Date.now() + Number(hours) * 3600000, ...(participation === 'join' ? { participation: 'join' } : {}) })
    }}>
      <label className={css.field} htmlFor={`${id}-participation`}>{t('contribution.join.purpose')}<select id={`${id}-participation`} value={participation} disabled={pending} onChange={(event) => { setParticipation(event.target.value as typeof participation) }}>
        <option value="group">{t('contribution.group.create')}</option>
        <option value="join">{t('contribution.join.create')}</option><option value="contribution">{t('contribution.join.contributionOnly')}</option>
      </select></label>
      {participation === 'contribution' && <label className={css.field} htmlFor={`${id}-source-kind`}>{t('contribution.sourceKind')}<select id={`${id}-source-kind`} value={sourceKind} disabled={pending} onChange={(event) => { setSourceKind(event.target.value as typeof sourceKind) }}>
        <option value="tool-observations">{t('contribution.toolObservations')}</option><option value="openapi">{t('contribution.openApi')}</option>
      </select></label>}
      {participation === 'group' && <>
        <label className={css.field} htmlFor={`${id}-capacity`}>{t('contribution.group.capacity')}
          <Input id={`${id}-capacity`} type="number" min="1" required value={capacity} disabled={pending}
            onChange={(event) => { setCapacity(event.target.value) }} /></label>
        <p className={css.hint}>{t('contribution.group.capacityHint')}</p>
      </>}
      <label className={css.field} htmlFor={`${id}-hours`}>{t('contribution.application.entryHours')}<Input id={`${id}-hours`} type="number" min="1" required value={hours} disabled={pending} onChange={(event) => { setHours(event.target.value) }} /></label>
      <p className={css.hint}>{t(participation === 'group' ? 'contribution.group.entryHint'
        : participation === 'join' ? 'contribution.join.entryHint' : 'contribution.application.entryHint')}</p>
      <Button type="submit" disabled={pending || !ownerAddress || !validHours || (participation === 'group' && !validCapacity)}>{t(createLabel)}</Button>
    </form>
    {groups?.map(({ group, applications: members }) => <section key={group.entry.entryId}
      data-group-entry={group.entry.entryId} className={css.record}>
      <h4>{t('contribution.group.title')}</h4>
      <p role="status">{t(`contribution.group.state.${group.state}`)}</p>
      <p>{t('contribution.group.count', { count: group.applicationCount, capacity: group.entry.maxMembers })}</p>
      <details open={group.state === 'open'}><summary>{t('contribution.application.entryText')}</summary>
        <ContributionTransferText text={recovered?.entry.entryId === group.entry.entryId ? recovered.text : group.text}
          label={t('contribution.application.entryText')} t={t} />
      </details>
      <p className={css.hint}>{t('contribution.application.entryExpires')}: {new Date(group.entry.expiresAt).toLocaleString()}</p>
      <p className={css.hint}>{t('contribution.group.closeHint')}</p>
      <div className={css.actions}>
        {group.state === 'open' && <Button variant="ghost" disabled={pending}
          onClick={() => { void closeGroupEntry(taskId, { entryId: group.entry.entryId }) }}>{t('contribution.group.close')}</Button>}
        <Button variant="outline" disabled={pending || !ownerAddress}
          onClick={() => { recover(group.entry.entryId) }}>{t('contribution.application.recover')}</Button>
      </div>
      {members.entries.map(item => <div key={item.applicationId} data-group-application={item.applicationId} className={css.record}>
        <p role="status">{t(`contribution.application.owner.${item.result.status}`)}</p>
        <p className={css.hint}>{t('contribution.join.permissions')}</p>
        {(item.result.status === 'approved' || item.result.status === 'ended') && item.result.readState !== undefined
          && <p role="status" data-join-read-permission>{t(`contribution.join.read.${item.result.readState}`)}</p>}
        <dl className={css.permission}>
          <dt>{t('contribution.sourcePeer')}</dt><dd>{item.proposal.contributorPeerId}</dd>
          <dt>{t('contribution.group.capture')}</dt><dd>{item.proposal.captureId}</dd>
          <dt>{t('contribution.group.captureGeneration')}</dt><dd>{item.proposal.captureGeneration}</dd>
          <ContributionSourceSummary source={item.proposal.source} t={t} />
          {item.limits !== null && <>
            <dt>{t('contribution.expires')}</dt><dd>{new Date(item.limits.expiresAt).toLocaleString()}</dd>
            <dt>{t('contribution.maxSamples')}</dt><dd>{item.limits.maxSamples}</dd>
            <dt>{t('contribution.maxBytes')}</dt><dd>{item.limits.maxSampleBytes}</dd>
          </>}
        </dl>
        {(item.result.status === 'approved' || (item.result.status === 'ended' && item.result.readState === 'active'))
          && <Button variant="ghost" disabled={pending} onClick={() => {
            void rejectContributionApplication(taskId, { entryId: group.entry.entryId, applicationId: item.applicationId,
              expectedProposal: item.proposal })
          }}>{t('contribution.group.endMember')}</Button>}
        {item.result.status === 'pending' && <div className={css.actions}>
          {item.limits !== null && <JoinApproval pending={pending || !ownerAddress} t={t} approve={(responsibility) => {
            if (item.limits === null) return
            void approveContributionApplication(taskId, { entryId: group.entry.entryId, applicationId: item.applicationId,
              expectedProposal: item.proposal, limits: item.limits, ownerAddress, read: { responsibility } })
          }} />}
          <Button variant="ghost" disabled={pending} onClick={() => {
            void rejectContributionApplication(taskId, { entryId: group.entry.entryId, applicationId: item.applicationId,
              expectedProposal: item.proposal })
          }}>{t('contribution.application.reject')}</Button>
        </div>}
      </div>)}
    </section>)}
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
            recover(item.entry.entryId)
          }}>{t('contribution.application.recover')}</Button>
        </div>
      </div>
    })}
  </section>
}
