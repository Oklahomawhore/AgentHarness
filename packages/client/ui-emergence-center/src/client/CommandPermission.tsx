/** Exact command-result selectors shared by separately authorized source kinds. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeScopeAction.module.css'

/** Editable command selectors retain exact command text and an explicitly selected directory. */
export interface CommandDraft {
  readonly enabled: boolean
  readonly selectors: readonly { readonly command: string; readonly rootIndex: string }[]
}

/**
 * Start a command draft without permission or a guessed command.
 * @returns one empty selector with sharing disabled.
 */
export function emptyCommands(): CommandDraft {
  return { enabled: false, selectors: [{ command: '', rootIndex: '' }] }
}

/**
 * Resolve explicitly selected command fields without rewriting shell text.
 * @param draft - current command fields and separate opt-in.
 * @param roots - ordered directories from the displayed permission.
 * @returns absent permission, exact selectors, or null for an incomplete selection.
 */
export function commandSelectors(draft: CommandDraft, roots: readonly string[]):
readonly { readonly command: string; readonly rootIndex: number }[] | undefined | null {
  if (!draft.enabled) return undefined
  if (draft.selectors.length === 0 || new Set(roots).size !== roots.length) return null
  const selectors = draft.selectors.map(value => ({ command: value.command, rootIndex: Number(value.rootIndex) }))
  if (draft.selectors.some(value => value.command.trim() === '' || value.rootIndex === '')
    || selectors.some(value => !Number.isSafeInteger(value.rootIndex) || value.rootIndex < 0 || value.rootIndex >= roots.length)
    || new Set(selectors.map(value => JSON.stringify(value))).size !== selectors.length) return null
  return selectors
}

/** Localized command fields and source-specific collection semantics. */
export interface CommandPermissionLabels {
  readonly consent: string
  readonly hint: string
  readonly item: (index: number) => string
  readonly command: string
  readonly cwd: string
  readonly chooseRoot: string
  readonly root: (index: number) => string
  readonly remove: string
  readonly add: string
  readonly limits: string
}

/**
 * Edit exact commands and directory selections, independently from file operations.
 * @param props - current draft, ordered local directories, editing state and owner callback.
 * @returns a default-off permission and bounded form rows, without executing commands.
 */
export function CommandPermission({ id, draft, roots, disabled, unavailable, change, labels }:
{
  id: string
  draft: CommandDraft
  roots: readonly string[]
  disabled: boolean
  unavailable: boolean
  change: (draft: CommandDraft) => void
  labels: CommandPermissionLabels
}) {
  return <div className={css.form} data-command-permission>
    <label className={css.consent}><input type="checkbox" checked={draft.enabled} disabled={disabled || unavailable}
      onChange={(event) => { change({ ...draft, enabled: event.target.checked }) }} />{labels.consent}</label>
    {draft.enabled && <>
      <p className={css.hint}>{labels.hint}</p>
      {draft.selectors.map((selector, index) => <fieldset key={index} className={css.modes} disabled={disabled}>
        <legend>{labels.item(index + 1)}</legend>
        <label className={css.field} htmlFor={`${id}-command-${index}`}>{labels.command}
          <textarea id={`${id}-command-${index}`} required rows={2} value={selector.command}
            onChange={(event) => { change({ ...draft, selectors: draft.selectors.map((item, at) => at === index
              ? { ...item, command: event.target.value } : item) }) }} /></label>
        <label className={css.field} htmlFor={`${id}-command-root-${index}`}>{labels.cwd}
          <select id={`${id}-command-root-${index}`} required value={selector.rootIndex}
            onChange={(event) => { change({ ...draft, selectors: draft.selectors.map((item, at) => at === index
              ? { ...item, rootIndex: event.target.value } : item) }) }}>
            <option value="">{labels.chooseRoot}</option>
            {roots.map((path, rootIndex) => <option key={rootIndex} value={rootIndex}>
              {labels.root(rootIndex + 1)}: {path}
            </option>)}
          </select></label>
        {draft.selectors.length > 1 && <Button size="sm" onClick={() => {
          change({ ...draft, selectors: draft.selectors.filter((_, at) => at !== index) })
        }}>{labels.remove}</Button>}
      </fieldset>)}
      <Button size="sm" disabled={disabled} onClick={() => {
        change({ ...draft, selectors: [...draft.selectors, { command: '', rootIndex: '' }] })
      }}>{labels.add}</Button>
      <p className={css.hint}>{labels.limits}</p>
    </>}
  </div>
}
