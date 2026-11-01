/** Original Claude session permissions are independent of native work permissions. */
import type { ClaudeScopeContributionSource } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CommandPermission, commandSelectors, emptyCommands, type CommandDraft } from './CommandPermission.tsx'
import css from './ClaudeScopePanel.module.css'

/** Explicit category choices for one new original-session contribution. */
export interface ClaudeWorkDraft {
  readonly write: boolean
  readonly edit: boolean
  readonly commands: CommandDraft
  readonly stopReports: boolean
}

/** Start without any permitted work category.
 * @returns unchecked file, command and Stop report choices.
 */
export function emptyClaudeWork(): ClaudeWorkDraft {
  return { write: false, edit: false, commands: emptyCommands(), stopReports: false }
}

/** Resolve only explicitly selected categories and exact command selectors.
 * @param draft - local category choices without existing grant authority.
 * @param roots - displayed directories in their submitted order.
 * @returns a complete local source request, or null when no category or an incomplete category is selected.
 */
export function claudeWorkSource(draft: ClaudeWorkDraft, roots: readonly string[]):
Extract<ClaudeScopeContributionSource, { kind: 'claude-work' }> | null {
  const tools: ('Write' | 'Edit')[] = []
  if (draft.write) tools.push('Write')
  if (draft.edit) tools.push('Edit')
  const commands = commandSelectors(draft.commands, roots)
  if (commands === null || (tools.length === 0 && commands === undefined && !draft.stopReports)
    || ((tools.length > 0 || commands !== undefined) && roots.length === 0)) return null
  return { kind: 'claude-work', tools, commands: commands ?? [], stopReports: draft.stopReports }
}

/** Show independently selectable categories without native file reads or turn-completion claims.
 * @param props - current choices, ordered directories, editing state and owner callback.
 * @returns default-off permissions for automatic future Claude work contributions.
 */
export function ClaudeWorkPermission({ id, draft, roots, disabled, change, t }: PropsLocale<'emergenceCenter'> & {
  id: string
  draft: ClaudeWorkDraft
  roots: readonly string[]
  disabled: boolean
  change: (draft: ClaudeWorkDraft) => void
}) {
  return <div className={css.form} data-claude-work-permission>
    <p className={css.hint}>{t('claude.work.hint')}</p>
    <label className={css.description}><input type="checkbox" checked={draft.write} disabled={disabled}
      onChange={(event) => { change({ ...draft, write: event.target.checked }) }} />{t('claude.work.write')}</label>
    <label className={css.description}><input type="checkbox" checked={draft.edit} disabled={disabled}
      onChange={(event) => { change({ ...draft, edit: event.target.checked }) }} />{t('claude.work.edit')}</label>
    <p className={css.hint}>{t('claude.work.filesHint')}</p>
    <CommandPermission id={id} draft={draft.commands} roots={roots} disabled={disabled} unavailable={false}
      change={(commands) => { change({ ...draft, commands }) }} labels={{
        consent: t('claude.work.commands'), hint: t('claude.work.commandsHint'),
        item: index => t('native.commands.item', { index }), command: t('native.commands.command'),
        cwd: t('native.commands.cwd'), chooseRoot: t('native.commands.chooseRoot'),
        root: index => t('native.commands.root', { index }), remove: t('native.commands.remove'),
        add: t('native.commands.add'), limits: t('claude.work.limits'),
      }} />
    <label className={css.description}><input type="checkbox" checked={draft.stopReports} disabled={disabled}
      onChange={(event) => { change({ ...draft, stopReports: event.target.checked }) }} />{t('claude.work.stopReports')}</label>
    <p className={css.hint}>{t('claude.work.stopHint')}</p>
    {!draft.commands.enabled && <p className={css.hint}>{t('claude.work.limits')}</p>}
  </div>
}
