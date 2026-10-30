/** Native foreground command-result consent; it does not authorize execution. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CommandPermission, type CommandDraft } from './CommandPermission.tsx'
export { emptyCommands as emptyNativeCommands, commandSelectors as nativeCommandSelectors } from './CommandPermission.tsx'
/** Editable native command selectors with a separate collection opt-in. */
export type NativeCommandDraft = CommandDraft

/**
 * Edit native command-result permission independently from file operations.
 * @param props - current draft, ordered directories, editing state and owner callback.
 * @returns native permission copy around the shared exact command fields.
 */
export function NativeCommandPermission({ t, ...props }: PropsLocale<'emergenceCenter'> & {
  id: string
  draft: NativeCommandDraft
  roots: readonly string[]
  disabled: boolean
  unavailable: boolean
  change: (draft: NativeCommandDraft) => void
}) {
  return <div data-native-command-permission><CommandPermission {...props} labels={{
    consent: t('native.commands.consent'), hint: t('native.commands.hint'),
    item: index => t('native.commands.item', { index }), command: t('native.commands.command'),
    cwd: t('native.commands.cwd'), chooseRoot: t('native.commands.chooseRoot'),
    root: index => t('native.commands.root', { index }), remove: t('native.commands.remove'),
    add: t('native.commands.add'), limits: t('native.commands.limits'),
  }} /></div>
}
