/** Explicit, local-only suggestions for a new native file-sharing permission. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ScopeAgentContributionPermissionDraft } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeScopeAction.module.css'

/** Read-only permission suggestions; calling this does not create a capture or contact an owner. */
export interface NativePermissionSuggestionActions {
  readonly suggestNativeContributionPermission: (agentId: SessionId) => Promise<ScopeAgentContributionPermissionDraft | null>
}

/**
 * Fill a draft only when the selected Session, permission and user edits still match the request.
 * @param props - local suggestion callback, draft identity, edit revision and explicit result handler.
 * @returns a local-only suggestion action and its availability state.
 */
export function NativePermissionSuggestion({ agentId, identity, revision, disabled, suggestNativeContributionPermission, apply, t,
}: NativePermissionSuggestionActions & PropsLocale<'emergenceCenter'> & {
  agentId: SessionId
  identity: string
  revision: string
  disabled: boolean
  apply: (draft: ScopeAgentContributionPermissionDraft) => void
}) {
  const generation = useRef(0)
  const [pending, setPending] = useState(false)
  const [issue, setIssue] = useState<'unavailable' | 'failed'>()
  useLayoutEffect(() => {
    generation.current++; setPending(false); setIssue(undefined)
    return () => { generation.current++ }
  }, [agentId, identity, revision, disabled])
  const suggest = async (): Promise<void> => {
    const current = ++generation.current
    setPending(true); setIssue(undefined)
    try {
      const draft = await suggestNativeContributionPermission(agentId)
      if (current !== generation.current) return
      setPending(false)
      if (draft === null) setIssue('unavailable')
      else apply(draft)
    } catch {
      // Host RPC failures leave the editable draft and all existing permissions unchanged.
      if (current !== generation.current) return
      setPending(false); setIssue('failed')
    }
  }
  return <div data-native-permission-suggestion className={css.form}>
    <Button disabled={disabled || pending} onClick={() => { void suggest() }}>{t('native.suggestion.use')}</Button>
    <p className={css.hint}>{t('native.suggestion.hint')}</p>
    {pending && <p role="status">{t('native.suggestion.loading')}</p>}
    {issue !== undefined && <p role="status">{t(`native.suggestion.${issue}`)}</p>}
  </div>
}
