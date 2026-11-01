/** Device-bound invitations and explicit read-only recipient selection. */

import { useEffect, useId, useRef, useState } from 'react'
import type {
  ScopeAccessIdentity, ScopeAccessList, ScopeInvitation, ScopeInviteRequest, ScopeGrantId,
  ScopePeerId, ClaudeScopeReceiveRequest, ClaudeScopeLeaveRequest, ClaudeScopeSessionSummary,
  CodexScopeReceiveRequest, CodexScopeLeaveRequest, CodexScopeSessionSummary, DevelopmentTaskId,
  McpClientSnapshot, McpClientSetupRequest, McpClientSetupResult,
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
  readonly readCodexScopes: () => void
  readonly receiveCodexScope: (request: CodexScopeReceiveRequest) => Promise<CodexScopeSessionSummary | undefined>
  readonly stopCodexReceive: (request: CodexScopeLeaveRequest) => Promise<CodexScopeSessionSummary | undefined>
}

/** Owner selection is absent unless the focused Task is a locally owned root. */
export interface ScopeAccessPanelProps extends ScopeAccessActions, PropsLocale<'emergenceCenter'> {
  readonly taskId?: DevelopmentTaskId
  readonly entry: ContributionEntry<ScopeAccessValue> | undefined
  readonly sessions: ClaudeScopeState
  readonly codexScopes: ContributionEntry<readonly CodexScopeSessionSummary[]> | undefined
  readonly codexClient: McpClientSnapshot | undefined
  readonly setupClient: (request: McpClientSetupRequest) => Promise<McpClientSetupResult>
}

type Recipient = { readonly runtime: 'claude'; readonly session: ClaudeScopeSessionSummary }
  | { readonly runtime: 'codex'; readonly session: CodexScopeSessionSummary }

/**
 * Exchange a public device identity once, then select an observed session for automatic context.
 * @param props - local management methods, selected owner Task, and observed recipients.
 * @returns invitation controls independent of local Task replication.
 */
export function ScopeAccessPanel({ taskId, entry, sessions, codexScopes, codexClient, setupClient, readScopeAccess, inviteScope,
  revokeScope, receiveClaudeScope, stopClaudeReceive, readCodexScopes, receiveCodexScope, stopCodexReceive, t }: ScopeAccessPanelProps) {
  const id = useId()
  const generation = useRef(0)
  const taskGeneration = useRef(0)
  const [error, setError] = useState(false)
  const [configuringCodex, setConfiguringCodex] = useState(false)
  const [codexSetupFailed, setCodexSetupFailed] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [address, setAddress] = useState<string>()
  const [responsibility, setResponsibility] = useState('')
  const [hours, setHours] = useState('24')
  const [created, setCreated] = useState<ScopeInvitation>()
  const [invitation, setInvitation] = useState('')
  const [selectedRecipient, setSelectedRecipient] = useState('')
  useEffect(() => {
    readScopeAccess()
    return () => { generation.current += 1 }
  }, [readScopeAccess])
  useEffect(() => { readCodexScopes() }, [readCodexScopes])
  useEffect(() => { taskGeneration.current += 1; setCreated(undefined) }, [taskId])
  const act = async (operation: () => Promise<void>): Promise<void> => {
    setError(false)
    try { await operation() }
    catch { setError(true) }
  }
  const data = entry?.value
  const currentAddress = resolveOwnerAddress(data?.identity.addresses ?? [], address)
  const pending = entry?.pending === true || entry?.status !== 'ready'
  const receiving = pending || codexScopes?.pending === true
  const recipients: Recipient[] = [
    ...sessions.sessions.filter(item => !item.ended).map(session => ({ runtime: 'claude' as const, session })),
    ...(codexScopes?.value ?? []).map(session => ({ runtime: 'codex' as const, session })),
  ]
  const chosen = recipients.find(item => `${item.runtime}:${item.session.sessionKey}` === selectedRecipient)
  const selectable = chosen?.runtime === 'claude'
    ? sessions.status === 'ready' && chosen.session.taskId === undefined && chosen.session.receiveSubscriptionId === undefined
      && chosen.session.sharingState !== 'withdrawal-pending'
    : chosen?.runtime === 'codex' && codexScopes?.status === 'ready' && !codexScopes.pending
      && chosen.session.receiveSubscriptionId === undefined
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
    {codexClient !== undefined && <div className={css.session}>
      <div className={css.sessionBody}>
        {codexClient.automaticContext !== undefined && <>
          <p className={css.hint}>{t(`access.codexSetup.${codexClient.automaticContext.state}`)}</p>
          <code className={css.path}>{codexClient.automaticContext.configPath}</code>
        </>}
        {codexClient.canSetup && <Button disabled={configuringCodex} onClick={() => {
          const current = generation.current
          setConfiguringCodex(true); setCodexSetupFailed(false)
          void setupClient({ clientId: codexClient.id }).catch(() => {
            if (current === generation.current) setCodexSetupFailed(true)
          }).finally(() => { if (current === generation.current) setConfiguringCodex(false) })
        }}>{t('access.setupCodex')}</Button>}
        {codexSetupFailed && <p className={css.error} role="alert">{t('access.codexSetupFailed')}</p>}
      </div>
    </div>}
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (!selectable || chosen === undefined) return
      void act(async () => {
        // The generated Remote validator checks the complete invitation before the Host acts.
        const parsed = JSON.parse(invitation) as ScopeInvitation
        const received = await (chosen.runtime === 'claude'
          ? receiveClaudeScope({ sessionKey: chosen.session.sessionKey, invitation: parsed })
          : receiveCodexScope({ sessionKey: chosen.session.sessionKey,
            expectedReadRevision: chosen.session.readRevision, invitation: parsed }))
        if (received !== undefined) setInvitation('')
      })
    }}>
      <label className={css.field} htmlFor={`${id}-invitation`}>{t('access.paste')}
        <textarea id={`${id}-invitation`} required rows={3} value={invitation} disabled={receiving} onChange={(event) => { setInvitation(event.target.value) }} />
      </label>
      <label className={css.field} htmlFor={`${id}-session`}>{t('claude.chooseSession')}
        <select id={`${id}-session`} value={selectedRecipient} disabled={receiving} onChange={(event) => { setSelectedRecipient(event.target.value) }}>
          <option value="">{t('access.choose')}</option>
          {recipients.map(item => <option key={`${item.runtime}:${item.session.sessionKey}`} value={`${item.runtime}:${item.session.sessionKey}`}
            disabled={item.runtime === 'claude' ? sessions.status !== 'ready' : codexScopes?.status !== 'ready' || codexScopes.pending}>
            {item.runtime === 'claude' ? item.session.sessionId : t('access.codexSession', { session: item.session.sessionId })}
          </option>)}
        </select>
      </label>
      <p className={css.hint}>{t('access.receiveHint')}</p>
      <p className={css.hint}>{t('access.codexHint')}</p>
      {codexScopes?.status === 'ready' && codexScopes.value?.length === 0 && <p className={css.hint}>{t('access.codexEmpty')}</p>}
      <Button disabled={codexScopes?.pending} onClick={readCodexScopes}>{t('access.refreshCodex')}</Button>
      <Button type="submit" disabled={receiving || data === undefined || !selectable || invitation.trim() === ''}>{t('access.receive')}</Button>
    </form>
    {sessions.sessions.filter(item => item.receiveSubscriptionId !== undefined).map(item => <div
      className={css.session} key={item.sessionKey}>
      <div className={css.sessionBody}><code className={css.path}>{item.sessionId}</code><span>{t(`access.state.${item.receiveState ?? 'pending'}`)}</span>
        <code className={css.path}>{item.receiveTaskId}</code>
        <Button disabled={pending} onClick={() => { void act(async () => { await stopClaudeReceive({ sessionKey: item.sessionKey }) }) }}>{t('access.stop')}</Button>
      </div>
    </div>)}
    {(codexScopes?.value ?? []).filter(item => item.receiveSubscriptionId !== undefined).map(item => <div
      className={css.session} key={`codex:${item.sessionKey}`}>
      <div className={css.sessionBody}><code className={css.path}>{t('access.codexSession', { session: item.sessionId })}</code>
        <span>{t(`access.state.${item.receiveState ?? 'pending'}`)}</span><code className={css.path}>{item.receiveTaskId}</code>
        <Button disabled={pending || codexScopes?.status !== 'ready' || codexScopes.pending} onClick={() => { void act(async () => {
          await stopCodexReceive({ sessionKey: item.sessionKey, expectedReadRevision: item.readRevision })
        }) }}>{t('access.stop')}</Button>
      </div>
    </div>)}
    {codexScopes?.error !== undefined && <p className={css.error} role="alert">{t('access.codexFailed')}</p>}
    {(error || entry?.status === 'ready' && entry.error !== undefined) && <p className={css.error} role="alert">{t('access.failed')}</p>}
    {entry?.status === 'error' && <div>
      <p className={css.error} role="alert">{t('access.loadFailed')}</p>
      <Button disabled={entry.pending} onClick={readScopeAccess}>{t('access.retry')}</Button>
    </div>}
  </details>
}
