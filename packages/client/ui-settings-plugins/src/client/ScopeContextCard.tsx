/** Explicit collaboration summary preferences applied by the Host at restart. */
import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScopeContextCardFace } from './scope-context-card-controller.ts'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './fields.module.css'
import layout from './ScopeContextCard.module.css'

/** Framework-composed summary card props. */
export type ScopeContextCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<ScopeContextCardFace>

/** Render summary selection without modifying the ordinary Session model.
 * @param props - Localized copy, observed preferences, and explicit card actions.
 * @returns The expandable collaboration summary card.
 */
export function ScopeContextCard(props: ScopeContextCardProps) {
  const { t } = props
  const id = useId()
  const state = props.useScopeContextCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  return <PluginCard t={t} titleKey="scopeContextTitle" descriptionKey="scopeContextDescription"
    state={state} onSave={props.save} onDiscard={props.discard}
    {...(state.saved ? { savedLabel: t('scopeContextSaved') } : {})}>
    <div data-scope-context-settings className={layout.content}>
      <div className={css.field}>
        <label className={css.label} htmlFor={`${id}-mode`}>{t('scopeContextMode')}</label>
        <select id={`${id}-mode`} className={css.input} value={state.mode} disabled={disabled}
          onChange={(event) => {
            if (event.target.value === 'reported' || event.target.value === 'semantic') props.chooseMode(event.target.value)
          }}>
          <option value="reported">{t('scopeContextReported')}</option>
          <option value="semantic">{t('scopeContextSemantic')}</option>
        </select>
      </div>
      {state.mode === 'semantic' && <>
        <div className={css.field}>
          <label className={css.label} htmlFor={`${id}-model`}>{t('scopeContextModel')}</label>
          <select id={`${id}-model`} className={css.input} value={state.selectedKey}
            disabled={disabled || state.catalogStatus !== 'ready'}
            onChange={(event) => { props.chooseModel(event.target.value) }}>
            <option value={'["",""]'} disabled>{t('scopeContextChoose')}</option>
            {state.candidates.map(candidate => <option key={candidate.key} value={candidate.key} disabled={!candidate.available}>
              {candidate.label}{candidate.available ? '' : ` (${t('scopeContextUnavailable')})`}
            </option>)}
          </select>
          {state.catalogStatus === 'loading' && <p role="status" className={css.hint}>{t('scopeContextLoading')}</p>}
          {state.catalogStatus === 'error' && <p role="alert" className={css.invalid}>{t('scopeContextLoadFailed')}</p>}
          {state.catalogPartial && <p role="status" className={css.hint}>{t('scopeContextPartial')}</p>}
          <button type="button" disabled={state.saving || state.catalogStatus === 'loading'} onClick={props.retryCatalog}>
            {t('scopeContextRetry')}
          </button>
        </div>
      </>}
      <div className={css.field}>
        <label className={css.label} htmlFor={`${id}-limit`}>{t('scopeContextMaxCalls')}</label>
        <input id={`${id}-limit`} className={css.input} type="number" inputMode="numeric" min="1" step="1"
          value={state.maxCalls} disabled={disabled}
          onChange={(event) => { props.editMaxCalls(event.target.value) }} />
        <p className={css.hint}>{t('scopeContextBudgetHint')}</p>
      </div>
      {state.mode === 'semantic' && <p className={css.hint}>{t('scopeContextDisclosure')}</p>}
      {state.invalid && !state.conflicted && <p role="alert" className={css.invalid}>{t('scopeContextInvalid')}</p>}
      <p className={css.hint}>{t('scopeContextRestart')}</p>
      {state.conflicted && <p role="alert" className={css.invalid}>{t('scopeContextConflict')}</p>}
    </div>
  </PluginCard>
}
