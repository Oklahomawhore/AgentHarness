/** Counts from the current binding's recorded shared context, without a delivery claim. */
import type { ScopeAgentRecordedContext } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './NativeScopeAction.module.css'

const otherReasons = ['self-published', 'unsupported', 'superseded', 'withdrawn', 'recipient-irrelevant'] as const

/**
 * Present shared frame size and excluded source counts without exposing their bodies.
 * @param props - Host-filtered current record and localized copy.
 * @returns a read-only summary, with non-budget exclusions under a details control.
 */
export function NativeRecordedContext({ recorded, t }: PropsLocale<'emergenceCenter'> & {
  recorded: ScopeAgentRecordedContext
}) {
  const reasons = otherReasons.filter(reason => recorded.omittedSourceCounts[reason] > 0)
  return <section data-native-recorded-context aria-label={t('native.recorded.title')} className={css.recorded}>
    <h3>{t('native.recorded.title')}</h3>
    <p>{t('native.recorded.summary', { bytes: recorded.sharedBytes, count: recorded.selectedSourceCount })}</p>
    <p>{t('native.recorded.budget', { count: recorded.omittedSourceCounts.budget })}</p>
    {reasons.length > 0 && <details>
      <summary>{t('native.recorded.other')}</summary>
      <dl className={css.details}>{reasons.map(reason => <div key={reason} className={css.recordedReason}>
        <dt>{t(`native.recorded.reason.${reason}`)}</dt>
        <dd>{t('native.recorded.count', { count: recorded.omittedSourceCounts[reason] })}</dd>
      </div>)}</dl>
    </details>}
    <p className={css.hint}>{t('native.recorded.bytesHint')}</p>
    <p className={css.hint}>{t('native.recorded.limit')}</p>
  </section>
}
