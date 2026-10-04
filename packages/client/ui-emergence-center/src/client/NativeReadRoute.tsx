/** Address recovery for an existing read binding without replacing its permission. */
import { useId, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeScopeAction.module.css'

/**
 * Edit a route whose owner identity and grant remain fixed by the Host.
 * @param props - displayed route, current mutation availability, action, and labels.
 * @returns the recovery form; the parent remounts it when binding or read state changes.
 */
export function NativeReadRoute({ current, ready, update, t }: PropsLocale<'emergenceCenter'> & {
  current: string
  ready: boolean
  update: (ownerAddress: string) => Promise<boolean>
}) {
  const id = useId()
  const [address, setAddress] = useState('')
  return <details data-native-read-route>
    <summary>{t('native.route.title')}</summary>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (ready && address.trim() !== '' && address.trim() !== current) void update(address.trim())
    }}>
      <p className={css.hint}>{t('native.route.readHint')}</p>
      <dl className={css.details}><dt>{t('native.route.old')}</dt><dd>{current}</dd></dl>
      <label className={css.field} htmlFor={`${id}-address`}>{t('native.route.new')}
        <input id={`${id}-address`} value={address} disabled={!ready} onChange={(event) => { setAddress(event.target.value) }} /></label>
      <Button type="submit" disabled={!ready || !address.trim() || address.trim() === current}>{t('native.route.apply')}</Button>
      <p className={css.hint}>{t('native.route.savedHint')}</p>
    </form>
  </details>
}
