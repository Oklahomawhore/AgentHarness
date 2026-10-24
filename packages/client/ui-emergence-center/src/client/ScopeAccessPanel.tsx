/** Device-bound invitations and explicit read-only recipient selection. */

import { useEffect, useId, useRef, useState } from 'react'
import type {
  ScopeAccessIdentity, ScopeAccessList, ScopeInvitation, ScopeInviteRequest, ScopeGrantId,
  ScopePeerId, ClaudeScopeReceiveRequest, ClaudeScopeLeaveRequest, ClaudeScopeSessionSummary,
  ClaudeScopeSessionKey, DevelopmentTaskId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeScopeState } from './claude-scopes.ts'
import type { ContributionEntry } from './contribution-directory.ts'
import css from './ClaudeScopePanel.module.css'
import { ScopeOwnerAddress, resolveOwnerAddress } from './ScopeOwnerAddress.tsx'

/** Last confirmed local identity and independent reading permissions. */
export interface ScopeAccessValue {
  readonly identity: ScopeAccessIdentity
  readonly access: ScopeAccessList
}

/** Local authenticated management; undefined results retain directory errors for reconciliation. */
export interface ScopeAccessActions {
  readonly readScopeAccess: () => void
  readonly inviteScope: (request: ScopeInviteRequest) => Promise<ScopeInvitation | undefined>
  readonly revokeScope: (request: { grantId: ScopeGrantId }) => Promise<void>
  readonly receiveClaudeScope: (request: ClaudeScopeReceiveRequest) => Promise<ClaudeScopeSessionSummary | undefined>
  readonly stopClaudeReceive: (request: ClaudeScopeLeaveRequest) => Promise<ClaudeScopeSessionSummary | undefined>
}

/** Owner selection is absent unless the focused Task is a locally owned root. */
export interface ScopeAccessPanelProps extends ScopeAccessActions, PropsLocale<'emergenceCenter'> {
  readonly taskId?: DevelopmentTaskId
  readonly entry: ContributionEntry<ScopeAccessValue> | undefined
  readonly sessions: ClaudeScopeState
}

/**
 * Exchange a public device identity once, then select an observed session for automatic context.
 * @param props - local management methods, selected owner Task, and observed recipients.
 * @returns invitation controls independent of local Task replication.
 */
export function ScopeAccessPanel({ taskId, entry, sessions, readScopeAccess, inviteScope,
  revokeScope, receiveClaudeScope, stopClaudeReceive, t }: ScopeAccessPanelProps) {
  const id = useId()
  const generation = useRef(0)
  const taskGeneration = useRef(0)
  const [error, setError] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [address, setAddress] = useState<string>()
  const [responsibility, setResponsibility] = useState('')
  const [hours, setHours] = useState('24')
  const [created, setCreated] = useState<ScopeInvitation>()
  const [invitation, setInvitation] = useState('')
  const [sessionKey, setSessionKey] = useState<ClaudeScopeSessionKey>()
  useEffect(() => {
    readScopeAccess()
    return () => { generation.current += 1 }
  }, [readScopeAccess])
  useEffect(() => { taskGeneration.current += 1; setCreated(undefined) }, [taskId])
  const act = async (operation: () => Promise<void>): Promise<void> => {
    const current = generation.current
    setError(false)
    try { await operation() }
    catch { if (current === generation.current) setError(true) }
  }
  const data = entry?.value
  const currentAddress = resolveOwnerAddress(data?.identity.addresses ?? [], address)
  const pending = entry?.pending === true || entry?.status !== 'ready'
  const chosen = sessions.sessions.find(item => item.sessionKey === sessionKey)
  const selectable = chosen !== undefined && !chosen.ended && chosen.taskId === undefined
    && chosen.receiveSubscriptionId === undefined && chosen.sharingState !== 'withdrawal-pending'
  return <details className={css.section}>
    <summary>{t('access.title')}</summary>
    <p className={css.description}>{t('access.description')}</p>
    {data !== undefined && <>
      <label className={css.field} htmlFor={`${id}-identity`}>{t('access.identity')}
        <textarea id={`${id}-identity`} readOnly rows={2} value={data.identity.peerId} />
      </label>
      <p className={css.hint}>{t('access.identityHint')}</p>
      {taskId === undefined ? <p className={css.hint}>{t('access.selectRoot')}</p> : <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        const selection = taskGeneration.current
        const current = generation.current
        void act(async () => {
          const value = await inviteScope({ taskId, recipientPeerId: recipient.trim() as ScopePeerId,
            ownerAddress: currentAddress, responsibility: responsibility.trim(), expiresAt: Date.now() + Number(hours) * 3600000 })
          if (selection === taskGeneration.current && current === generation.current) setCreated(value)
        })
      }}>
        <label className={css.field} htmlFor={`${id}-peer`}>{t('access.recipient')}
          <Input id={`${id}-peer`} required value={recipient} disabled={pending} onChange={(event) => { setRecipient(event.target.value) }} />
        </label>
        <ScopeOwnerAddress id={`${id}-address`} addresses={data.identity.addresses} value={currentAddress}
          disabled={pending} onChange={setAddress} t={t} />
        <label className={css.field} htmlFor={`${id}-role`}>{t('claude.responsibility')}
          <Input id={`${id}-role`} required value={responsibility} disabled={pending} onChange={(event) => { setResponsibility(event.target.value) }} />
        </label>
        <p className={css.hint}>{t('access.responsibilityHint')}</p>
        <label className={css.field} htmlFor={`${id}-hours`}>{t('access.hours')}
          <Input id={`${id}-hours`} required type="number" min="1" value={hours} disabled={pending} onChange={(event) => { setHours(event.target.value) }} />
        </label>
        <Button type="submit" disabled={pending || !recipient.trim() || !currentAddress || !responsibility.trim()}>{t('access.invite')}</Button>
      </form>}
      {created !== undefined && created.taskId === taskId && <label className={css.field} htmlFor={`${id}-created`}>{t('access.created')}
        <textarea id={`${id}-created`} readOnly rows={4} value={JSON.stringify(created)} />
      </label>}
      {data.access.grants.filter(grant => grant.invitation.taskId === taskId).map(grant => <div
        className={css.session} key={grant.invitation.grantId}>
        <div className={css.sessionBody}><code className={css.path}>{grant.invitation.recipientPeerId}</code>
          <span>{grant.state === 'revoked' ? t('access.revoked') : t('access.granted')}</span>
          {grant.state === 'active' && <Button disabled={pending} onClick={() => { void act(() => revokeScope({ grantId: grant.invitation.grantId })) }}>{t('access.revoke')}</Button>}
        </div>
      </div>)}
    </>}
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (!selectable) return
      void act(async () => {
        // The generated Remote validator checks the complete invitation before the Host acts.
        const parsed = JSON.parse(invitation) as ScopeInvitation
        const received = await receiveClaudeScope({ sessionKey: chosen.sessionKey, invitation: parsed })
        if (received !== undefined) setInvitation('')
      })
    }}>
      <label className={css.field} htmlFor={`${id}-invitation`}>{t('access.paste')}
        <textarea id={`${id}-invitation`} required rows={3} value={invitation} disabled={pending} onChange={(event) => { setInvitation(event.target.value) }} />
      </label>
      <label className={css.field} htmlFor={`${id}-session`}>{t('claude.chooseSession')}
        <select id={`${id}-session`} value={sessionKey ?? ''} disabled={pending || sessions.status !== 'ready'} onChange={(event) => { setSessionKey(event.target.value as ClaudeScopeSessionKey) }}>
          <option value="">{t('access.choose')}</option>
          {sessions.sessions.filter(item => !item.ended).map(item => <option key={item.sessionKey} value={item.sessionKey}>
            {item.sessionId}
          </option>)}
        </select>
      </label>
      <p className={css.hint}>{t('access.receiveHint')}</p>
      <Button type="submit" disabled={pending || data === undefined || !selectable || invitation.trim() === ''}>{t('access.receive')}</Button>
    </form>
    {sessions.sessions.filter(item => item.receiveSubscriptionId !== undefined).map(item => <div
      className={css.session} key={item.sessionKey}>
      <div className={css.sessionBody}><code className={css.path}>{item.sessionId}</code><span>{t(`access.state.${item.receiveState ?? 'pending'}`)}</span>
        <code className={css.path}>{item.receiveTaskId}</code>
        <Button disabled={pending} onClick={() => { void act(async () => { await stopClaudeReceive({ sessionKey: item.sessionKey }) }) }}>{t('access.stop')}</Button>
      </div>
    </div>)}
    {(error || entry?.status === 'ready' && entry.error !== undefined) && <p className={css.error} role="alert">{t('access.failed')}</p>}
    {entry?.status === 'error' && <div>
      <p className={css.error} role="alert">{t('access.loadFailed')}</p>
      <Button disabled={entry.pending} onClick={readScopeAccess}>{t('access.retry')}</Button>
    </div>}
  </details>
}
