/** Recorded automatic requests, completed responses, and scope evaluations for the current local goal. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NativeScopeSnapshot } from './native-scopes.ts'
import css from './NativeScopeAction.module.css'

/**
 * Present recorded evidence without treating configuration or a reservation as completed work.
 * @param props - current Session observation, selected target, and localized copy.
 * @returns a text-only evidence section, or no section without matching current evidence.
 */
export function NativeScopeActivity({ snapshot, local, t }: PropsLocale<'emergenceCenter'> & {
  snapshot: NativeScopeSnapshot
  local: boolean
}) {
  const observation = snapshot.observation
  if (snapshot.phase !== 'ready' || observation === null || observation.eligibility !== 'eligible'
    || observation.state.binding === null || observation.state.automatic === null
    || (observation.state.binding.kind === 'local-task') !== local) return null
  const { request, completed, evaluation } = observation.activity
  const showEvaluation = evaluation !== null && (evaluation.decision !== 'activate'
    || (evaluation.activationId !== request?.activationId && evaluation.activationId !== completed?.activationId))
  if (request === null && completed === null && !showEvaluation) return null
  return <section data-native-scope-activity aria-label={t('native.activity.title')} className={css.activity}>
    <h3>{t('native.activity.title')}</h3>
    {completed !== null && <p data-native-scope-activity-completed>{t('native.activity.completed', {
      turn: completed.turn, revision: completed.taskRevision,
    })}</p>}
    {request !== null && <p data-native-scope-activity-request>{t('native.activity.request', {
      turn: request.turn, step: request.step,
    })}</p>}
    {showEvaluation && <p data-native-scope-activity-evaluation={evaluation.decision}>{t(`native.activity.${evaluation.decision}`, {
      revision: evaluation.taskRevision,
    })}</p>}
  </section>
}
