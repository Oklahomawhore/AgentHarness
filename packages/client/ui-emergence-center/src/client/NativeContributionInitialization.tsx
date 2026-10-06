/** Delivery and coverage of explicitly selected pre-join tool observations. */
import type { ScopeAgentContributionInitialization } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EmergenceCenterKey } from './locales.ts'
import css from './NativeScopeAction.module.css'

/**
 * Distinguish a frozen selection from owner-confirmed delivery; neither establishes model adoption.
 * @param props - durable initialization coverage and locale dictionary.
 * @returns visible historical sharing progress without observation contents.
 */
export function NativeContributionInitialization({ value, t }: PropsLocale<'emergenceCenter'> & {
  value: ScopeAgentContributionInitialization
}) {
  const { coverage } = value
  const key: EmergenceCenterKey = value.state === 'pending' ? 'native.initialization.pending'
    : value.state === 'unavailable' ? 'native.initialization.stopped'
      : coverage.selected === 0 ? 'native.initialization.empty'
        : coverage.acknowledged === coverage.selected ? 'native.initialization.complete' : 'native.initialization.delivery'
  return <div data-native-initialization>
    <p role="status" className={css.state}>{t(key, { count: coverage.selected, acknowledged: coverage.acknowledged })}</p>
    {value.state !== 'pending' && <p className={css.hint}>{t('native.initialization.coverage', {
      recorded: coverage.recorded, selected: coverage.selected, omitted: coverage.omitted,
      unconfirmed: coverage.unconfirmed, inFlight: coverage.inFlight,
    })}</p>}
    {value.reason !== null && <p className={css.notice}>{t(`native.initialization.reason.${value.reason}`)}</p>}
    <p className={css.hint}>{t('native.initialization.limit')}</p>
  </div>
}
