/** Route-only recovery for the original native capture, including pending withdrawal. */
import { useEffect, useId, useRef, useState } from 'react'
import type {
  ScopeAgentContributionRecoverRouteRequest, ScopeAgentContributionSelection, ScopeContributionEntry, ScopeContributionTransfer,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeScopeAction.module.css'

function sameEntry(left: ScopeContributionEntry, right: ScopeContributionEntry): boolean {
  return left.kind === right.kind && left.entryId === right.entryId
    && left.taskId === right.taskId && left.ownerPeerId === right.ownerPeerId
    && left.sourceKind === right.sourceKind && left.expiresAt === right.expiresAt
}

/**
 * Preview the original owner's replacement route without collecting new permission.
 * @param props - exact displayed capture, Host parser, route mutation, and localized labels.
 * @returns recovery controls; the parent remounts them when capture or route changes.
 */
export function NativeContributionRoute({ agentId, current, ready, preview, recover, receive, t }: PropsLocale<'emergenceCenter'> & {
  agentId: SessionId
  current: { readonly selection: ScopeAgentContributionSelection; readonly routeRevision: number; readonly entry: ScopeContributionEntry }
  receive?: { readonly expectedReadStateSeq: SessionSeqCursor }
  ready: boolean
  preview: (text: string) => Promise<ScopeContributionTransfer>
  recover: (request: ScopeAgentContributionRecoverRouteRequest) => Promise<void>
}) {
  const id = useId()
  const revision = useRef(0)
  const sending = useRef(false)
  const [text, setText] = useState('')
  const [checked, setChecked] = useState<ScopeContributionEntry>()
  const [pending, setPending] = useState(false)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => () => { revision.current++ }, [])
  const verify = async (): Promise<void> => {
    const at = ++revision.current
    setPending(true); setChecked(undefined); setInvalid(false)
    try {
      const value = await preview(text)
      if (at !== revision.current) return
      if ((value.kind === 'contribution-entry' || value.kind === 'scope-join-entry')
        && value.sourceKind === 'tool-observations' && sameEntry(current.entry, value)
        && (value.ownerAddress !== current.entry.ownerAddress || receive !== undefined)) setChecked(value)
      else setInvalid(true)
    } catch { if (at === revision.current) setInvalid(true) }
    finally { if (at === revision.current) setPending(false) }
  }
  const submit = async (): Promise<void> => {
    if (!ready || checked === undefined || sending.current) return
    sending.current = true
    try {
      await recover({ agentId, expectedCapture: current.selection, expectedRouteRevision: current.routeRevision,
        expectedOwnerAddress: current.entry.ownerAddress, entry: checked,
        ...(receive === undefined ? {} : { receive }) })
    } finally { sending.current = false }
  }
  return <details data-native-contribution-route>
    <summary>{t('native.route.title')}</summary>
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <p className={css.hint}>{t('native.route.hint')}</p>
      <label className={css.field} htmlFor={`${id}-route`}>{t('native.route.paste')}
        <textarea id={`${id}-route`} rows={3} value={text} disabled={!ready} onChange={(event) => {
          revision.current++; setText(event.target.value); setChecked(undefined); setPending(false); setInvalid(false)
        }} /></label>
      <Button disabled={!ready || pending || !text.trim()} onClick={() => { void verify() }}>{t('native.route.verify')}</Button>
      {invalid && <p role="alert" className={css.notice}>{t('native.route.invalid')}</p>}
      <dl className={css.details}><dt>{t('native.route.old')}</dt><dd>{current.entry.ownerAddress}</dd>
        {checked !== undefined && <><dt>{t('native.route.new')}</dt><dd>{checked.ownerAddress}</dd></>}
      </dl>
      <Button type="submit" disabled={!ready || pending || checked === undefined}>{t('native.route.apply')}</Button>
      <p className={css.hint}>{t('native.route.savedHint')}</p>
    </form>
  </details>
}
