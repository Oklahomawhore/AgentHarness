/** Read participation owned by one external-session joint application. */
import { useId, useState } from 'react'
import type { ClaudeScopeJointSummary, ClaudeScopeSessionSummary, ClaudeScopeLeaveJointRequest,
  ClaudeScopeRecoverJointRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ClaudeScopePanel.module.css'

/** Show retained receiving independently of source collection, including after source stop.
 * @param props - Exact observed joint operation, current read revision, and local management actions.
 * @returns Receiving status, joint departure, and explicit address recovery; no model execution controls.
 */
export function ClaudeJointControls({ session, joint, ready, leave, recover, t }: PropsLocale<'emergenceCenter'> & {
  session: ClaudeScopeSessionSummary
  joint: ClaudeScopeJointSummary
  ready: boolean
  leave: (request: ClaudeScopeLeaveJointRequest) => Promise<void>
  recover: (request: ClaudeScopeRecoverJointRequest) => Promise<void>
}) {
  const id = useId()
  const [address, setAddress] = useState('')
  const terminal = joint.state === 'ended' || joint.state === 'superseded'
  const manageable = !terminal || joint.cleanupPending
  const ending = joint.intent !== 'adopt' && manageable
  const preparing = joint.intent === 'adopt'
    && (joint.state === 'waiting' || joint.state === 'adopting' || joint.state === 'active')
  return <section data-claude-joint className={css.record} aria-label={t('claude.joint.title')}>
    <h3>{t('claude.joint.title')}</h3>
    <p role="status" className={css.notice}>{t(ending ? 'claude.joint.ending' : `claude.joint.state.${joint.state}`)}</p>
    {preparing && <p className={css.hint}>{t('claude.joint.passiveHint')}</p>}
    {manageable && <>
      <Button disabled={!ready} onClick={() => { void leave({ sessionKey: session.sessionKey, jointId: joint.id }) }}>
        {t('claude.joint.leave')}
      </Button>
      <p className={css.hint}>{t('claude.joint.leaveHint')}</p>
      <details data-claude-joint-route><summary>{t('native.route.title')}</summary>
        <form className={css.form} onSubmit={(event) => {
          event.preventDefault()
          void recover({ sessionKey: session.sessionKey, jointId: joint.id,
            expectedReadRevision: session.readRevision, ownerAddress: address.trim() })
        }}>
          <p className={css.hint}>{t('claude.joint.routeHint')}</p>
          <label className={css.field} htmlFor={`${id}-address`}>{t('native.route.new')}
            <Input id={`${id}-address`} value={address} disabled={!ready}
              onChange={(event) => { setAddress(event.target.value) }} />
          </label>
          <Button type="submit" disabled={!ready || !address.trim()}>{t('native.route.apply')}</Button>
          <p className={css.hint}>{t('native.route.savedHint')}</p>
        </form>
      </details>
    </>}
  </section>
}
