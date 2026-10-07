/** Task-owner approval and recovery of independently authorized contributions. */
import { useEffect, useId, useRef, useState } from 'react'
import type { DevelopmentTaskId, ScopeContributionTransfer,
  ScopeContributionApproveRequest, ScopeContributionRecoverRequest, ScopeContributionApproval,
  ScopeContributionInvitation, ScopeContributionProposal } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContributionEntry } from './contribution-directory.ts'
import { contributionErrorKey, ContributionGrantSummary, ContributionTransferText, ContributionSourceSummary } from './contribution-ui.tsx'
import css from './ClaudeScopePanel.module.css'
import { ScopeOwnerAddress, resolveOwnerAddress } from './ScopeOwnerAddress.tsx'
import { OwnerContributionApplications, type OwnerApplicationActions } from './OwnerContributionApplications.tsx'

import type { OwnerContributionValue } from './owner-contributions.ts'
export type { OwnerContributionValue } from './owner-contributions.ts'

/** Typed local management, separate from read-grant controls. */
export interface OwnerContributionActions extends OwnerApplicationActions {
  readonly readOwnedContributions: (taskId: DevelopmentTaskId) => void
  readonly moreOwnedContributions: (taskId: DevelopmentTaskId) => void
  readonly approveContribution: (request: ScopeContributionApproveRequest) => Promise<ScopeContributionApproval | undefined>
  readonly recoverContribution: (request: ScopeContributionRecoverRequest) => Promise<ScopeContributionApproval | undefined>
  readonly revokeContribution: (request: { grant: ScopeContributionInvitation['grant'] }) => Promise<void>
  readonly previewContributionText: (text: string) => Promise<ScopeContributionTransfer>
}

/** Issue application entries, approve exact source consent and recover original grants.
 * @param props - selected local root Task, observed inventory and authenticated actions.
 * @returns owner approval and independent contribution termination controls.
 */
export function OwnerContributionPanel({ taskId, entry, readOwnedContributions, moreOwnedContributions, approveContribution,
  recoverContribution, revokeContribution, previewContributionText, createContributionEntry, recoverContributionEntry,
  approveContributionApplication, rejectContributionApplication, createGroupEntry, closeGroupEntry, t }: OwnerContributionActions & PropsLocale<'emergenceCenter'> & {
    taskId: DevelopmentTaskId | undefined
    entry: ContributionEntry<OwnerContributionValue> | undefined
  }) {
  const id = useId()
  const generation = useRef(0)
  const [text, setText] = useState('')
  const [proposal, setProposal] = useState<ScopeContributionProposal>()
  const [invalid, setInvalid] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [address, setAddress] = useState<string>()
  const [hours, setHours] = useState('')
  const [samples, setSamples] = useState('')
  const [bytes, setBytes] = useState('')
  const [approval, setApproval] = useState<ScopeContributionApproval>()
  useEffect(() => {
    if (taskId !== undefined) readOwnedContributions(taskId)
    return () => { generation.current += 1 }
  }, [taskId, readOwnedContributions])
  const addresses = entry?.value?.identity.addresses ?? []
  const currentAddress = resolveOwnerAddress(addresses, address)
  const pending = entry?.pending === true || entry?.status !== 'ready' || previewing
  const grant = approval?.invitation.grant
  const permissionValid = [hours, samples, bytes].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)
  const verify = async (): Promise<void> => {
    const issued = ++generation.current
    setPreviewing(true); setInvalid(false); setProposal(undefined)
    try {
      const value = await previewContributionText(text)
      if (generation.current !== issued) return
      if (value.kind === 'openapi-contribution-request' || value.kind === 'tool-contribution-request') setProposal(value.proposal)
      else setInvalid(true)
    } catch { if (generation.current === issued) setInvalid(true) }
    finally { if (generation.current === issued) setPreviewing(false) }
  }
  const show = async (operation: () => Promise<ScopeContributionApproval | undefined>): Promise<void> => {
    const issued = generation.current
    const value = await operation()
    if (generation.current === issued) setApproval(value)
  }
  return <details data-scope-contribution-owner className={css.section}>
    <summary>{t('contribution.ownerTitle')}</summary>
    <p className={css.hint}>{t('contribution.ownerHint')}</p>
    {taskId === undefined ? <p className={css.notice}>{t('access.selectRoot')}</p> : <>
      <Button size="sm" variant="ghost" disabled={entry?.pending} onClick={() => { setApproval(undefined); readOwnedContributions(taskId) }}>{t('contribution.refreshOwner')}</Button>
      {entry?.status === 'loading' && <p role="status" className={css.hint}>{t('contribution.loading')}</p>}
      {entry?.status === 'error' && <p role="alert" className={css.error}>{t('contribution.loadFailed')}</p>}
      <ScopeOwnerAddress id={`${id}-address`} addresses={addresses} value={currentAddress}
        disabled={pending} onChange={setAddress} t={t} />
      <OwnerContributionApplications taskId={taskId} applications={entry?.value?.applications} groups={entry?.value?.groups.entries}
        ownerAddress={currentAddress} pending={pending}
        createContributionEntry={createContributionEntry} recoverContributionEntry={recoverContributionEntry}
        createGroupEntry={createGroupEntry} closeGroupEntry={closeGroupEntry}
        approveContributionApplication={approveContributionApplication}
        rejectContributionApplication={rejectContributionApplication} t={t} />
      <details data-contribution-manual-owner><summary>{t('contribution.application.manual')}</summary>
        <form className={css.form} onSubmit={(event) => { event.preventDefault(); void verify() }}>
          <label className={css.field} htmlFor={`${id}-proposal`}>{t('contribution.pasteProposal')}<textarea id={`${id}-proposal`} rows={3} required value={text} disabled={pending} onChange={(event) => {
            generation.current += 1; setText(event.target.value); setProposal(undefined); setInvalid(false); setApproval(undefined)
          }} /></label>
          <Button type="submit" variant="outline" disabled={pending || !text.trim()}>{t('contribution.verifyProposal')}</Button>
        </form>
        {proposal !== undefined && <form className={css.form} onSubmit={(event) => {
          event.preventDefault()
          void show(() => approveContribution({ taskId, ownerAddress: currentAddress, proposal,
            expiresAt: Date.now() + Number(hours) * 3600000, maxSamples: Number(samples), maxSampleBytes: Number(bytes) }))
        }}>
          <dl className={css.permission}><dt>{t('contribution.sourcePeer')}</dt><dd>{proposal.contributorPeerId}</dd>
            <ContributionSourceSummary source={proposal.source} t={t} /></dl>
          <label className={css.field} htmlFor={`${id}-hours`}>{t('contribution.hours')}<Input id={`${id}-hours`} type="number" min="1" required value={hours} disabled={pending} onChange={(event) => { setHours(event.target.value) }} /></label>
          <label className={css.field} htmlFor={`${id}-samples`}>{t('contribution.maxSamples')}<Input id={`${id}-samples`} type="number" min="1" required value={samples} disabled={pending} onChange={(event) => { setSamples(event.target.value) }} /></label>
          <label className={css.field} htmlFor={`${id}-bytes`}>{t('contribution.maxBytes')}<Input id={`${id}-bytes`} type="number" min="1" required value={bytes} disabled={pending} onChange={(event) => { setBytes(event.target.value) }} /></label>
          <Button type="submit" disabled={pending || !currentAddress || !permissionValid}>{t('contribution.approve')}</Button>
        </form>}
      </details>
      {approval !== undefined && grant?.taskId === taskId && <>
        <ContributionGrantSummary grant={grant} t={t} />
        <ContributionTransferText key={approval.text} text={approval.text} label={t('contribution.invitationText')} t={t} />
      </>}
      {entry?.value?.inventory.entries.map(item => <div className={css.record} key={item.grant.grantId}>
        <strong>{item.grant.source.name}</strong>
        <span role="status">{t(item.state === 'active' ? 'contribution.ownerActive' : `contribution.end.${item.reason}`)}</span>
        <ContributionGrantSummary grant={item.grant} t={t} />
        <div className={css.actions}>
          <Button variant="outline" disabled={pending || !currentAddress} onClick={() => { void show(() => recoverContribution({ taskId,
            grantId: item.grant.grantId, generation: item.grant.generation, ownerAddress: currentAddress })) }}>{t(item.state === 'active' ? 'contribution.recover' : 'contribution.recoverEnded')}</Button>
          {item.state === 'active' && <Button variant="ghost" disabled={pending} onClick={() => { setApproval(undefined); void revokeContribution({ grant: item.grant }) }}>{t('contribution.revoke')}</Button>}
        </div>
      </div>)}
      {(entry?.value?.inventory.nextGrantId != null || entry?.value?.applications.nextEntryId != null
        || entry?.value?.groups.nextEntryId != null || entry?.value?.groups.entries.some(group => group.applications.nextApplicationId !== null)) && <Button variant="outline" disabled={entry.pending} onClick={() => { moreOwnedContributions(taskId) }}>{t('contribution.more')}</Button>}
      {entry?.status === 'ready' && entry.value?.inventory.entries.length === 0 && <p className={css.empty}>{t('contribution.noGrants')}</p>}
    </>}
    {invalid && <p role="alert" className={css.error}>{t('contribution.error.text')}</p>}
    {entry?.error !== undefined && <p role="alert" className={css.error}>{t(contributionErrorKey(entry.error))}</p>}
  </details>
}
