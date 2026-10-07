/** Current-Session participation in a locally owned Task, with separate file consent. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  DevelopmentTaskId, ScopeAgentContributionStopRequest, ScopeAgentLocalContributionRequest,
  ScopeAgentLocalContributionStatus,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContributionEntry } from './contribution-directory.ts'
import { contributionErrorKey, NativeCommandSummary } from './contribution-ui.tsx'
import { NativeContributionPermission, type NativeContributionDraft } from './NativeContributionPermission.tsx'
import { NativeLocalAutomaticPanel } from './NativeLocalAutomaticPanel.tsx'
import type { NativeScopeAction, NativeScopeSnapshot } from './native-scopes.ts'
import { emptyNativeCommands, nativeCommandSelectors } from './NativeCommandPermission.tsx'
import { NativePermissionSuggestion, type NativePermissionSuggestionActions } from './NativePermissionSuggestion.tsx'
import css from './NativeScopeAction.module.css'

/** Local Task commands supplied by the owning management directory. */
export interface NativeLocalContributionActions extends NativePermissionSuggestionActions {
  readonly readNativeLocalContribution: (agentId: SessionId) => void
  readonly checkoutNativeLocalTask: (agentId: SessionId, taskId: DevelopmentTaskId) => Promise<void>
  readonly requestNativeLocalContribution: (request: ScopeAgentLocalContributionRequest) => Promise<void>
  readonly stopNativeLocalContribution: (request: ScopeAgentContributionStopRequest) => Promise<void>
}

/**
 * Connect a current Agent to an owned Task, then authorize only selected file work.
 * @param props - current Session, authoritative local status, owned Task choices and commands.
 * @returns local receiving status and a separately confirmed source permission.
 */
export function NativeLocalContributionPanel({ agentId, entry, tasks, catalogReady, receivingElsewhere, scope, actScope,
  readNativeLocalContribution, checkoutNativeLocalTask, requestNativeLocalContribution, stopNativeLocalContribution,
  suggestNativeContributionPermission, t,
}: NativeLocalContributionActions & PropsLocale<'emergenceCenter'> & {
  agentId: SessionId
  entry: ContributionEntry<ScopeAgentLocalContributionStatus> | undefined
  tasks: readonly { readonly id: DevelopmentTaskId; readonly objective: string }[]
  catalogReady: boolean
  receivingElsewhere: boolean
  scope: NativeScopeSnapshot
  actScope: (action: NativeScopeAction) => Promise<boolean>
}) {
  const id = useId()
  const busy = useRef(false)
  const [selected, setSelected] = useState<DevelopmentTaskId>()
  const [consentedBinding, setConsentedBinding] = useState<ScopeAgentLocalContributionStatus['assignment']>(null)
  const [draft, setDraft] = useState<NativeContributionDraft>({
    roots: '', write: false, edit: false, hours: '', samples: '', bytes: '', consent: false, fileContent: false, commands: emptyNativeCommands(),
  })
  useEffect(() => { readNativeLocalContribution(agentId) }, [agentId, readNativeLocalContribution])
  const status = entry?.value
  const capture = status?.capture
  const assignment = status?.assignment
  useLayoutEffect(() => {
    setDraft(value => ({ ...value, consent: false, fileContent: false, commands: emptyNativeCommands() })); setConsentedBinding(null)
  }, [agentId, assignment?.bindingId, assignment?.expectedBindingEpoch.seq, assignment?.expectedBindingEpoch.nodeId,
    capture?.selection.captureId, capture?.selection.captureGeneration])
  const ready = entry?.status === 'ready' && !entry.pending && !scope.pending
  const eligible = ready && status?.eligibility === 'eligible'
  const canConnect = ready && status?.eligibility === 'no-local-task' && !receivingElsewhere
  const chosen = tasks.find(task => task.id === selected)
  const activeTaskId = capture?.grant.taskId ?? assignment?.taskId
  const title = tasks.find(task => task.id === activeTaskId)?.objective ?? activeTaskId
  const enteredRoots = draft.roots.split('\n').map(value => value.trim()).filter(Boolean)
  const roots = draft.commands.enabled ? enteredRoots : [...new Set(enteredRoots)]
  const commands = nativeCommandSelectors(draft.commands, roots)
  const tools: ('write' | 'edit')[] = [...(draft.write ? ['write' as const] : []), ...(draft.edit ? ['edit' as const] : [])]
  const expiresAt = Date.now() + Number(draft.hours) * 3_600_000
  const limitsValid = [draft.hours, draft.samples, draft.bytes].every(value => value.trim() !== ''
    && Number.isSafeInteger(Number(value)) && Number(value) > 0) && Number.isSafeInteger(expiresAt)
  const consentIsCurrent = assignment != null && consentedBinding !== null
    && assignment.taskId === consentedBinding.taskId && assignment.bindingId === consentedBinding.bindingId
    && assignment.expectedBindingEpoch.nodeId === consentedBinding.expectedBindingEpoch.nodeId
    && assignment.expectedBindingEpoch.seq === consentedBinding.expectedBindingEpoch.seq
  const permissionReady = eligible && capture === null && assignment != null && draft.consent
    && roots.length > 0 && (tools.length > 0 || commands !== undefined) && commands !== null && limitsValid
  const canRequest = permissionReady && consentIsCurrent
  const executionBinding = scope.observation?.eligibility === 'not-live' ? null : scope.observation?.state.binding?.id
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try { await operation() } finally { busy.current = false }
  }
  return <section data-native-local-contribution className={css.form}>
    <p className={css.hint}>{t('native.local.hint')}</p>
    {entry?.status === 'loading' && <p role="status">{t('contribution.loading')}</p>}
    {entry?.error !== undefined && <p role="alert" className={css.notice}>{t(contributionErrorKey(entry.error))}</p>}
    {status !== undefined && status.eligibility !== 'eligible' && status.eligibility !== 'no-local-task'
      && <p className={css.notice}>{t(`native.local.eligibility.${status.eligibility}`)}</p>}
    {receivingElsewhere && <p className={css.notice}>{t('native.local.remoteRead')}</p>}
    {ready && assignment === null && capture === null && <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (canConnect && chosen !== undefined) void perform(() => checkoutNativeLocalTask(agentId, chosen.id))
    }}>
      <label className={css.field} htmlFor={`${id}-task`}>{t('native.local.task')}
        <select id={`${id}-task`} value={selected ?? ''} disabled={!catalogReady || !canConnect}
          onChange={(event) => { setSelected(event.target.value as DevelopmentTaskId) }}>
          <option value="">{t('native.local.choose')}</option>
          {tasks.map(task => <option key={task.id} value={task.id}>{task.objective}</option>)}
        </select>
      </label>
      {catalogReady && tasks.length === 0 && <p className={css.hint}>{t('native.local.empty')}</p>}
      <Button type="submit" disabled={!catalogReady || chosen === undefined || !canConnect}>{t('native.local.connect')}</Button>
    </form>}
    {assignment != null && <>
      <p role="status" className={css.state}>{t('native.local.connected', { task: title ?? assignment.taskId })}</p>
      <p className={css.hint}>{t('native.local.receiveHint')}</p>
      <NativeLocalAutomaticPanel
        key={`${assignment.taskId}/${assignment.bindingId}/${assignment.expectedBindingEpoch.nodeId}/${assignment.expectedBindingEpoch.seq}/${executionBinding ?? ''}`}
        assignment={assignment} snapshot={scope} act={actScope} t={t} />
    </>}
    {capture === null && assignment != null && <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      if (!permissionReady || !consentIsCurrent) return
      void perform(() => requestNativeLocalContribution({ agentId, expectedCapture: null, ...assignment, roots, tools,
        limits: { expiresAt, maxSamples: Number(draft.samples), maxSampleBytes: Number(draft.bytes) },
        ...(commands == null ? {} : { commands }),
        ...(draft.fileContent && tools.length > 0 ? { fileContent: 'completed-native-file' as const } : {}) }))
    }}>
      <p role="status">{t('native.share.none')}</p>
      <NativePermissionSuggestion agentId={agentId} identity={JSON.stringify(assignment)} revision={JSON.stringify(draft)}
        disabled={!eligible} suggestNativeContributionPermission={suggestNativeContributionPermission} t={t} apply={(suggestion) => {
          setDraft({ roots: suggestion.roots.join('\n'), write: suggestion.tools.includes('write'), edit: suggestion.tools.includes('edit'),
            hours: String(suggestion.durationHours), samples: String(suggestion.maxSamples), bytes: String(suggestion.maxSampleBytes),
            consent: false, fileContent: false, commands: emptyNativeCommands() })
          setConsentedBinding(null)
        }} />
      <NativeContributionPermission id={id} draft={{ ...draft, consent: draft.consent && consentIsCurrent }} disabled={!eligible}
        consentKey={draft.commands.enabled ? 'native.commands.localConsent' : 'native.local.consent'} change={(value) => {
          const changed = value.roots !== draft.roots || value.write !== draft.write || value.edit !== draft.edit
            || value.hours !== draft.hours || value.samples !== draft.samples || value.bytes !== draft.bytes
            || value.commands !== draft.commands
          setDraft(changed ? { ...value, consent: false, fileContent: false,
            commands: value.roots !== draft.roots ? { ...value.commands, enabled: false,
              selectors: value.commands.selectors.map(item => ({ ...item, rootIndex: '' })) } : value.commands } : value)
          setConsentedBinding(!changed && value.consent ? assignment : null)
        }} t={t} />
      <Button type="submit" variant="primary" disabled={!canRequest}>{t('native.local.enable')}</Button>
    </form>}
    {capture != null && <>
      <p role="status" className={css.state}>{t(capture.state === 'opening' ? 'native.local.opening'
        : capture.state === 'ending' ? 'native.local.ending' : capture.collecting ? capture.commands === undefined ? 'native.share.active' : 'native.commands.active' : 'native.share.paused')}</p>
      <dl className={css.details}>
        <dt>{t('native.local.task')}</dt><dd>{title}</dd>
        <dt>{t('contribution.roots')}</dt><dd>{capture.roots.join('\n')}</dd>
        {capture.tools.length > 0 && <><dt>{t('native.fileContent.scope')}</dt>
          <dd>{t(capture.grant.source.fileContent === 'completed-native-file'
            ? 'native.fileContent.complete' : 'native.fileContent.arguments')}</dd></>}
        <dt>{t('native.share.tools')}</dt>
        <dd>{capture.tools.map(tool => t(tool === 'write' ? 'native.share.write' : 'native.share.edit')).join(', ')}</dd>
        {capture.commands !== undefined && <><dt>{t('native.commands.scope')}</dt><dd>
          <NativeCommandSummary commands={capture.commands} t={t} />
        </dd></>}
        <dt>{t('contribution.expires')}</dt><dd>{new Date(capture.grant.expiresAt).toLocaleString()}</dd>
        <dt>{t('contribution.maxSamples')}</dt><dd>{capture.grant.maxSamples}</dd>
        <dt>{t('contribution.maxBytes')}</dt><dd>{capture.grant.maxSampleBytes}</dd>
      </dl>
      <p className={css.hint}>{t('native.share.pending', { count: capture.pendingSamples })}</p>
      {capture.collectionIssue !== null && <p role="status" className={css.notice}>
        {t(`native.share.collection.${capture.collectionIssue}`)}
      </p>}
      {capture.issue !== null && <p className={css.notice}>{t(`native.local.issue.${capture.issue}`)}</p>}
      <Button disabled={!ready} onClick={() => {
        void perform(() => stopNativeLocalContribution({ agentId, expectedCapture: capture.selection }))
      }}>
        {t(capture.state === 'ending' ? 'native.share.retryStop' : 'native.share.stop')}
      </Button>
      <p className={css.hint}>{t(capture.commands === undefined ? 'native.local.stopHint' : 'native.commands.stopHint')}</p>
    </>}
    <Button size="sm" disabled={entry?.pending} onClick={() => { readNativeLocalContribution(agentId) }}>{t('native.share.refresh')}</Button>
  </section>
}
