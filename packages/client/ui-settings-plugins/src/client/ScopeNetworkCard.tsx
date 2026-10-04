/** Explicit network preferences applied only after a Host restart. */
import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScopeNetworkCardFace } from './scope-network-card-controller.ts'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './fields.module.css'
import layout from './ScopeNetworkCard.module.css'

/** Framework-composed collaboration network card props. */
export type ScopeNetworkCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<ScopeNetworkCardFace>

/** Render saved listener preferences without claiming they are already listening.
 * @param props - Localized copy, card observation and explicit settings actions.
 * @returns The existing expandable settings card.
 */
export function ScopeNetworkCard(props: ScopeNetworkCardProps) {
  const { t } = props
  const id = useId()
  const state = props.useScopeNetworkCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  return <PluginCard t={t} titleKey="scopeNetworkTitle" descriptionKey="scopeNetworkDescription"
    state={state} onSave={props.save} onDiscard={props.discard}
    {...(state.saved ? { savedLabel: t('scopeNetworkSaved') } : {})}>
    <div data-scope-network-settings className={layout.content}>
      <div className={css.field}>
        <label className={css.label} htmlFor={`${id}-mode`}>{t('scopeNetworkMode')}</label>
        <select id={`${id}-mode`} className={css.input} value={state.mode} disabled={disabled}
          onChange={(event) => {
            if (event.target.value === 'local' || event.target.value === 'lan') props.chooseMode(event.target.value)
          }}>
          <option value="local">{t('scopeNetworkLocal')}</option>
          <option value="lan">{t('scopeNetworkLan')}</option>
          {state.mode === 'custom' && <option value="custom" disabled>{t('scopeNetworkCustom')}</option>}
        </select>
        {state.mode === 'local' && <p className={css.hint}>{t('scopeNetworkLocalHint')}</p>}
      </div>
      {state.mode === 'lan' && <div className={css.field}>
        <label className={css.label} htmlFor={`${id}-port`}>{t('scopeNetworkPort')}</label>
        <input id={`${id}-port`} className={css.input} type="number" inputMode="numeric" min="1" max="65535"
          aria-invalid={state.invalid && !state.conflicted} value={state.port} disabled={disabled}
          onChange={(event) => { props.editPort(event.target.value) }} />
        <p className={css.hint}>{t('scopeNetworkLanHint')}</p>
        {state.invalid && !state.conflicted && <p role="alert" className={css.invalid}>{t('scopeNetworkInvalidPort')}</p>}
      </div>}
      {state.mode === 'custom' && <div className={css.field}>
        <label className={css.label} htmlFor={`${id}-custom`}>{t('scopeNetworkCustom')}</label>
        <textarea id={`${id}-custom`} className={layout.addresses} rows={3} readOnly value={state.customAddresses.join('\n')} />
        <p className={css.hint}>{t('scopeNetworkCustomHint')}</p>
      </div>}
      <p className={css.hint}>{t('scopeNetworkRestart')}</p>
      <p className={css.hint}>{t('scopeNetworkPermission')}</p>
      {state.remote && <p role="status" className={css.hint}>{t('scopeNetworkRemote')}</p>}
      {state.conflicted && <p role="alert" className={css.invalid}>{t('scopeNetworkConflict')}</p>}
    </div>
  </PluginCard>
}
