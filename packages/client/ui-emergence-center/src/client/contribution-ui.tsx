/** Shared presentation for locally confirmed contribution permissions. */
import { useEffect, useId, useState } from 'react'
import type { ScopeContributionInvitation } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EmergenceCenterKey } from './locales.ts'
import css from './ClaudeScopePanel.module.css'

/** Map management codes to recovery copy without exposing diagnostics.
 * @param code - structured Host code or unknown-outcome marker.
 * @returns localized recovery message key.
 */
export function contributionErrorKey(code: string): EmergenceCenterKey {
  switch (code) {
    case 'claude-scope/stale-capture': case 'claude-scope/contribution-superseded':
    case 'scope-contribution/stale-selection': return 'contribution.error.stale'
    case 'claude-scope/session-unavailable': return 'contribution.error.session'
    case 'claude-scope/local-permission-invalid': case 'scope-contribution/invalid-permission': return 'contribution.error.permission'
    case 'claude-scope/source-conflict': case 'scope-contribution/source-conflict': return 'contribution.error.conflict'
    case 'claude-scope/invitation-mismatch': case 'scope-contribution/invalid-text': return 'contribution.error.text'
    case 'claude-scope/grant-ended': case 'scope-contribution/grant-ended': return 'contribution.error.ended'
    case 'scope-contribution/capacity': return 'contribution.error.capacity'
    case 'claude-scope/contribution-unavailable': case 'scope-contribution/unavailable': return 'contribution.error.unavailable'
    default: return 'contribution.error.unknown'
  }
}

/** Copy a Host-produced transfer document without requiring JSON editing.
 * @param props - canonical text, localized label and dictionary.
 * @returns selectable transfer text and clipboard feedback.
 */
export function ContributionTransferText({ text, label, t }: PropsLocale<'emergenceCenter'> & { text: string; label: string }) {
  const id = useId()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setCopied(false); setFailed(false) }, [text])
  return <div className={css.form}>
    <label className={css.field} htmlFor={id}>{label}
      <textarea id={id} readOnly rows={3} value={text} onFocus={(event) => { event.currentTarget.select() }} />
    </label>
    <Button size="sm" variant="outline" onClick={() => { void writeClipboard(text).then((ok) => { setCopied(ok); setFailed(!ok) }) }}>
      {t(copied ? 'contribution.copied' : 'contribution.copy')}
    </Button>
    {failed && <p role="status" className={css.hint}>{t('contribution.copyFailed')}</p>}
  </div>
}

/** Show the exact owner permission before enabling capture or transferring its invitation.
 * @param props - immutable owner grant and localized labels.
 * @returns permission fields without implying a sample or model receipt.
 */
export function ContributionGrantSummary({ grant, t }: PropsLocale<'emergenceCenter'> & { grant: ScopeContributionInvitation['grant'] }) {
  return <dl className={css.permission}>
    <dt>{t('contribution.task')}</dt><dd>{grant.taskId}</dd>
    <dt>{t('contribution.owner')}</dt><dd>{grant.ownerPeerId}</dd>
    <dt>{t('contribution.sourcePeer')}</dt><dd>{grant.contributorPeerId}</dd>
    <ContributionSourceSummary source={grant.source} t={t} />
    <dt>{t('contribution.expires')}</dt><dd>{new Date(grant.expiresAt).toLocaleString()}</dd>
    <dt>{t('contribution.maxSamples')}</dt><dd>{grant.maxSamples}</dd>
    <dt>{t('contribution.maxBytes')}</dt><dd>{grant.maxSampleBytes}</dd>
  </dl>
}

/** Show the scope of an approved source without exposing private local paths.
 * @param props - exact source permission and localized labels.
 * @returns source fields suitable for a permission description list.
 */
export function ContributionSourceSummary({ source, t }: PropsLocale<'emergenceCenter'> & { source: ScopeContributionInvitation['grant']['source'] }) {
  return <>
    <dt>{t('contribution.sourceName')}</dt><dd>{source.name}</dd>
    {source.kind === 'tool-observations' ? <><dt>{t('contribution.sourceKind')}</dt><dd>{t('contribution.toolObservations')}</dd>
      <dt>{t('contribution.tools')}</dt><dd>{source.tools.join(', ')}</dd>
      {source.version === 4 && <><dt>{t('native.commands.scope')}</dt><dd>
        <NativeCommandSummary commands={source.commands} t={t} />
      </dd></>}
      {source.version === 2 && <><dt>{t('contribution.initialization')}</dt><dd>{t('contribution.recordedTools')}</dd></>}
      {source.fileContent === 'completed-native-file' && <><dt>{t('native.fileContent.scope')}</dt><dd>{t('native.fileContent.complete')}</dd></>}</>
      : <><dt>{t('contribution.operation')}</dt><dd>{source.method.toUpperCase()} {source.path}</dd></>}
  </>
}

/**
 * Display the approved command and public directory number without exposing local paths.
 * @param props - exact command selectors from an observed permission and translations.
 * @returns the selected commands and their separate working-directory identities.
 */
export function NativeCommandSummary({ commands, t }: PropsLocale<'emergenceCenter'> & {
  commands: readonly { readonly command: string; readonly rootIndex: number }[]
}) {
  return <ul>{commands.map((item, index) => <li key={index}>
    <code style={{ whiteSpace: 'pre-wrap' }}>{item.command}</code> — {t('native.commands.root', { index: item.rootIndex + 1 })}
  </li>)}</ul>
}
