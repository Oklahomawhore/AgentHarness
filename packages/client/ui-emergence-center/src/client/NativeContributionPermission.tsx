/** Shared explicit file and command-result permission for local and independent Task sources. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EmergenceCenterKey } from './locales.ts'
import { NativeCommandPermission, type NativeCommandDraft } from './NativeCommandPermission.tsx'
import css from './NativeScopeAction.module.css'

/** Uncommitted local form values; no value grants permission until submitted. */
export interface NativeContributionDraft {
  readonly roots: string
  readonly write: boolean
  readonly edit: boolean
  readonly hours: string
  readonly samples: string
  readonly bytes: string
  readonly consent: boolean
  readonly fileContent: boolean
  readonly commands: NativeCommandDraft
}

/**
 * Render explicit roots, file and command selection, limits and separate consent in the incumbent form style.
 * @param props - unique field prefix, local draft, editing state and localized consent label.
 * @returns controlled source-permission fields without a submit action.
 */
export function NativeContributionPermission({ id, draft, disabled, fileContentDisabled, consentKey, change, t,
}: PropsLocale<'emergenceCenter'> & {
  id: string
  draft: NativeContributionDraft
  disabled: boolean
  fileContentDisabled?: boolean
  consentKey: EmergenceCenterKey
  change: (value: NativeContributionDraft) => void
}) {
  const roots = draft.roots.split('\n').map(value => value.trim()).filter(Boolean)
  return <>
    <label className={css.field} htmlFor={`${id}-roots`}>{t('contribution.roots')}
      <textarea id={`${id}-roots`} rows={2} required value={draft.roots} disabled={disabled}
        onChange={(event) => { change({ ...draft, roots: event.target.value }) }} /></label>
    <fieldset className={css.modes} disabled={disabled}><legend>{t('native.share.tools')}</legend>
      <label><input type="checkbox" checked={draft.write} onChange={(event) => { change({ ...draft, write: event.target.checked }) }} />{t('native.share.write')}</label>
      <label><input type="checkbox" checked={draft.edit} onChange={(event) => { change({ ...draft, edit: event.target.checked }) }} />{t('native.share.edit')}</label>
    </fieldset>
    <div className={css.numbers}>
      <label className={css.field} htmlFor={`${id}-hours`}>{t('contribution.hours')}<Input id={`${id}-hours`} type="number" min="1" required value={draft.hours} disabled={disabled} onChange={(event) => { change({ ...draft, hours: event.target.value }) }} /></label>
      <label className={css.field} htmlFor={`${id}-samples`}>{t('contribution.maxSamples')}<Input id={`${id}-samples`} type="number" min="1" required value={draft.samples} disabled={disabled} onChange={(event) => { change({ ...draft, samples: event.target.value }) }} /></label>
      <label className={css.field} htmlFor={`${id}-bytes`}>{t('contribution.maxBytes')}<Input id={`${id}-bytes`} type="number" min="1" required value={draft.bytes} disabled={disabled} onChange={(event) => { change({ ...draft, bytes: event.target.value }) }} /></label>
    </div>
    <label className={css.consent}><input type="checkbox" checked={draft.fileContent} disabled={disabled || fileContentDisabled || (!draft.write && !draft.edit)}
      onChange={(event) => { change({ ...draft, fileContent: event.target.checked }) }} />{t('native.fileContent.consent')}</label>
    <p className={css.hint}>{t('native.fileContent.hint')}</p>
    <NativeCommandPermission id={id} draft={draft.commands} roots={roots} disabled={disabled}
      unavailable={fileContentDisabled === true} t={t} change={(commands) => { change({ ...draft, commands }) }} />
    <label className={css.consent}><input type="checkbox" checked={draft.consent} disabled={disabled}
      onChange={(event) => { change({ ...draft, consent: event.target.checked }) }} />{t(consentKey)}</label>
  </>
}
