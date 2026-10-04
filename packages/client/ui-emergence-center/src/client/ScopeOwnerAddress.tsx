/** Select only addresses currently published by the owning Host; selection does not establish remote reachability. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ClaudeScopePanel.module.css'

/** Current published addresses and the owner's local selection. */
interface ScopeOwnerAddressProps extends PropsLocale<'emergenceCenter'> {
  readonly id: string
  readonly addresses: readonly string[]
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (address: string) => void
}

/** Resolve an unedited single-address choice; an obsolete explicit choice remains empty.
 * @param addresses - current Host-published values.
 * @param selected - explicit selection, or undefined before a user choice.
 * @returns a current address or an empty value requiring selection.
 */
export function resolveOwnerAddress(addresses: readonly string[], selected: string | undefined): string {
  if (selected !== undefined) return addresses.includes(selected) ? selected : ''
  return addresses.length === 1 ? (addresses[0] ?? '') : ''
}

function displayAddress(address: string): { local: boolean; label: string } {
  const [, protocol, host, transport, port] = address.split('/')
  if ((protocol !== 'ip4' && protocol !== 'ip6') || host === undefined || transport !== 'tcp' || port === undefined) {
    return { local: false, label: address }
  }
  return { local: protocol === 'ip4' ? host.startsWith('127.') : host === '::1',
    label: protocol === 'ip6' ? `[${host}]:${port}` : `${host}:${port}` }
}

/** Render published-address choices and the persistent network-setup path.
 * @param props - current addresses, selected value, locale, and local selection callback.
 * @returns a selector that cannot submit an invented or stale address.
 */
export function ScopeOwnerAddress({ id, addresses, value, disabled, onChange, t }: ScopeOwnerAddressProps) {
  return <>
    <label className={css.field} htmlFor={id}>{t('access.address')}
      <select id={id} required value={value} disabled={disabled || addresses.length === 0}
        onChange={(event) => { onChange(event.target.value) }}>
        <option value="">{t('access.addressChoose')}</option>
        {addresses.map((address) => {
          const display = displayAddress(address)
          return <option key={address} value={address}>
            {t(display.local ? 'access.addressLocal' : 'access.addressNetwork', { address: display.label })}
          </option>
        })}
      </select>
    </label>
    <p className={css.hint}>{t('access.addressHint')}</p>
    {value !== '' && displayAddress(value).local && <p role="status" className={css.notice}>{t('access.addressLocalHint')}</p>}
    <p className={css.hint}>{t('access.addressSetupHint')}</p>
  </>
}
