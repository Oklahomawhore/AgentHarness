/** Explicit sharing of future completed visible answers, independent of file and execution permissions. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NativeContributionLimits, type NativeContributionLimitsDraft } from './NativeContributionPermission.tsx'
import css from './NativeScopeAction.module.css'

/** Uncommitted completed-answer sharing limits and consent. */
export type NativeTurnOutcomeDraft = NativeContributionLimitsDraft & { readonly consent: boolean }

/**
 * Explain the answer source and collect its distinct disclosure permission.
 * @param props - current limits, consent, receiver ownership and localized labels.
 * @returns source explanation, bounded limits and an unchecked-by-default consent control.
 */
export function NativeTurnOutcomePermission({ id, draft, disabled, remote, change, t }: PropsLocale<'emergenceCenter'> & {
  id: string
  draft: NativeTurnOutcomeDraft
  disabled: boolean
  remote: boolean
  change: (value: NativeTurnOutcomeDraft) => void
}) {
  return <div data-native-turn-outcome-permission className={css.form}>
    <p className={css.hint}>{t('native.outcomes.hint')}</p>
    <p className={css.hint}>{t('native.outcomes.scope')}</p>
    <NativeContributionLimits id={id} draft={draft} disabled={disabled} t={t}
      change={(limits) => { change({ ...draft, ...limits, consent: false }) }} />
    <label className={css.consent}><input type="checkbox" checked={draft.consent} disabled={disabled}
      onChange={(event) => { change({ ...draft, consent: event.target.checked }) }} />
    {t(remote ? 'native.outcomes.remoteConsent' : 'native.outcomes.localConsent')}</label>
  </div>
}
