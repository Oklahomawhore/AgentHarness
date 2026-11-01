/** Original Claude command and Stop reports, with prompt consent separate from native tool leases. */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { DevelopmentTaskClaudeCommandObservationResult, DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { claudeCommandObservationResultSchema, claudeStopReportResultSchema } from '@deepseek-ai/dsh-development-task/schema'
import { validateContributionReceipt } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeContributionSample } from '@deepseek-ai/dsh-scope-access/types'
import { authorizeClaudeScopeTool, claudeScopeToolArgumentDigest, renderClaudeScopeToolContribution } from './capture.ts'
import type { ScopeContribution } from './contribution-state.ts'
import type { ContributionLimits } from './contribution.ts'
import type { ScopeDomain } from './state.ts'
import type { ScopeWorkLease } from './work-state.ts'
import type { ClaudeScopeHookInput, ClaudeScopeHookResult, ClaudeScopeOmission, ClaudeScopePreparedInput, ClaudeScopeSessionKey } from './types.ts'
import { scopeDigest } from './projection.ts'

type WorkHookInput = Extract<ClaudeScopeHookInput, { readonly event: 'UserPromptSubmit' | 'Stop' | 'StopFailure'
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' }>

type ActiveWorkCapture = ScopeContribution & {
  readonly source: Extract<ScopeContribution['source'], { kind: 'claude-work' }>
  readonly invitation: NonNullable<ScopeContribution['invitation']>
}
type WorkPreparedInput = (Omit<ClaudeScopePreparedInput, 'toolName'> & { readonly toolName: 'Write' | 'Edit' }) | {
  readonly kind: 'eligible'
  readonly toolName: 'Bash'
  readonly fields: { readonly rootIndex: number; readonly command: string }
  readonly inputDigest: string
}

const digestText = (text: string) => createHash('sha256').update(text).digest('hex')
const omitted = (reason: string): ClaudeScopeHookResult => ({ output: {}, receipt: { status: 'omitted', reason } })
const omission = (reason: string): ClaudeScopeOmission => ({ kind: 'omitted', reason })
const identity = (key: ClaudeScopeSessionKey, capture: ScopeContribution) => ({ sessionKey: key,
  captureId: capture.proposal.captureId, captureGeneration: capture.proposal.captureGeneration })
const keyFor = (key: ClaudeScopeSessionKey, capture: ScopeContribution, ...parts: readonly unknown[]) =>
  `work:${scopeDigest([key, capture.proposal.captureId, capture.proposal.captureGeneration, ...parts])}`

/** Count every retained grant lease and report against one adapter-wide retention limit.
 * @param domain - open adapter records.
 * @returns total durable row count across all capture forms.
 */
export function retainedLeaseCount(domain: ScopeDomain): number {
  return domain.table('leases').size + domain.table('contribution_leases').size + domain.table('work_leases').size
}

/** Validate source, report identity and original owner receipt before retrying durable work.
 * @param key - persisted row key.
 * @param lease - parsed Claude-work row.
 * @param capture - exact current local capture.
 * @returns after rejecting changed report or authority associations.
 */
export function validateWorkLease(key: string, lease: ScopeWorkLease, capture: ScopeContribution): void {
  if (!('kind' in capture.source) || capture.source.kind !== 'claude-work'
    || lease.captureId !== capture.proposal.captureId || lease.captureGeneration !== capture.proposal.captureGeneration) {
    throw new Error('claude-scope: work lease has a different capture identity')
  }
  const source = capture.source
  const expected = lease.kind === 'tool' ? keyFor(lease.sessionKey, capture, 'tool', lease.toolUseId)
    : lease.kind === 'prompt' ? keyFor(lease.sessionKey, capture, 'prompt')
      : keyFor(lease.sessionKey, capture, 'Stop', lease.promptId, lease.textDigest, lease.stopHookActive)
  if (key !== expected || (lease.kind !== 'tool' && !source.stopReports)
    || (lease.kind === 'tool' && (lease.toolName === 'Bash' ? source.commands.length === 0 : !source.tools.includes(lease.toolName)))) {
    throw new Error('claude-scope: work lease lacks its original local permission')
  }
  if (lease.kind === 'prompt') return
  const sample = lease.sample
  if (sample !== undefined) {
    const result = sample.result
    const sourceId = lease.kind === 'stop-report' ? key.slice('work:'.length) : scopeDigest([key, lease.terminal, sample.sequence])
    if (capture.invitation === undefined || sample.sequence > capture.sequence || sample.sourceId !== sourceId || !('kind' in result)) {
      throw new Error('claude-scope: work sample has a different source identity')
    }
    if (lease.kind === 'stop-report') {
      if (result.kind !== 'claude-stop-report' || result.sha256 !== lease.textDigest || digestText(result.text) !== lease.textDigest
        || result.stopHookActive !== lease.stopHookActive) throw new Error('claude-scope: Stop sample differs from its retained report')
    } else if (lease.terminal === undefined || lease.completionDigest === undefined
      || (lease.toolName === 'Bash' ? result.kind !== 'claude-command-observation' || result.hookEvent !== lease.terminal
        || !source.commands.some(command => command.rootIndex === result.fields.rootIndex && command.command === result.fields.command)
        : result.kind !== 'tool-observation' || result.version !== 1 || result.tool !== lease.toolName
          || result.reportedStatus !== (lease.terminal === 'PostToolUse' ? 'success' : 'failure'))) {
      throw new Error('claude-scope: work sample differs from its leased tool completion')
    }
  }
  if (lease.receipt !== undefined) {
    if (capture.invitation === undefined || sample === undefined) throw new Error('claude-scope: work receipt has no original sample')
    validateContributionReceipt(capture.invitation, lease.receipt, sample)
  }
}

async function authorize(tool: NonNullable<ClaudeScopeHookInput['tool']>, cwd: string | undefined,
  capture: ActiveWorkCapture): Promise<WorkPreparedInput | ClaudeScopeOmission> {
  const source = capture.source
  if (tool.name !== 'Bash') {
    const selected = source.tools.find(name => name === tool.name)
    if (selected === undefined) return omission('tool-outside-contribution')
    const prepared = await authorizeClaudeScopeTool(tool, cwd, capture.policy)
    return prepared.kind === 'omitted' ? prepared : { ...prepared, toolName: selected }
  }
  if (cwd === undefined) return omission('cwd-outside-grant')
  const prepared = await authorizeClaudeScopeTool(tool, cwd,
    { ...capture.policy, bashCommands: source.commands.map(command => command.command) })
  if (prepared.kind === 'omitted') return prepared
  const canonicalCwd = await realpath(cwd)
  const selected = source.commands.find(command => command.command === prepared.fields.command
    && capture.policy.roots[command.rootIndex] === canonicalCwd)
  if (selected === undefined) return omission('cwd-outside-command-grant')
  const fields = { rootIndex: selected.rootIndex, command: selected.command }
  return { kind: 'eligible', toolName: 'Bash', fields, inputDigest: scopeDigest([tool.input, fields, canonicalCwd]) }
}

function commandReport(event: 'PostToolUse' | 'PostToolUseFailure', tool: NonNullable<ClaudeScopeHookInput['tool']>,
  selector: Extract<WorkPreparedInput, { toolName: 'Bash' }>['fields'],
  fits: (result: ScopeContributionSample['result']) => boolean): DevelopmentTaskClaudeCommandObservationResult | ClaudeScopeOmission {
  let fields: DevelopmentTaskClaudeCommandObservationResult['fields'] = selector
  const omissions: DevelopmentTaskClaudeCommandObservationResult['omissions'][number][] = []
  const candidates: ['stdout' | 'stderr' | 'error', string][] = []
  if (event === 'PostToolUseFailure') {
    omissions.push('error')
    if (tool.error !== undefined) candidates.push(['error', tool.error])
  } else {
    const response = z.object({ stdout: z.string(), stderr: z.string(), interrupted: z.boolean(),
      backgroundTaskId: z.string().optional(), backgroundedByUser: z.boolean().optional(),
      timedOutAfterMs: z.number().optional(), dangerouslyDisableSandbox: z.boolean().optional() }).safeParse(tool.response)
    if (!response.success || (tool.isInterrupt === true && !response.data.interrupted)
      || response.data.timedOutAfterMs !== undefined || response.data.backgroundTaskId !== undefined
      || response.data.backgroundedByUser === true || response.data.dangerouslyDisableSandbox === true) {
      omissions.push('unsupported-tool-response')
    } else {
      fields = { ...fields, interrupted: response.data.interrupted }
      omissions.push('stdout', 'stderr')
      candidates.push(['stdout', response.data.stdout], ['stderr', response.data.stderr])
    }
  }
  let report: DevelopmentTaskClaudeCommandObservationResult = { kind: 'claude-command-observation', version: 7,
    tool: 'Bash', hookEvent: event, fields, omissions }
  if (!fits(report)) return omission('observation-attribution-exceeds-budget')
  for (const [field, value] of candidates) {
    const candidate = { ...report, fields: { ...report.fields, [field]: value },
      omissions: report.omissions.filter(name => name !== field) }
    if (fits(candidate)) report = candidate
  }
  return claudeCommandObservationResultSchema.parse(report)
}

/** Sample one explicitly authorized real hook without transcript or tool-output file access.
 * @param domain - serialized adapter records.
 * @param input - original parsed hook.
 * @param key - observed source session.
 * @param capture - locally active Claude-work capture; the owner authorizes each sample admission.
 * @param limits - shared retention and byte limits.
 * @param signal - command, capture and prompt lifetime.
 * @param save - durably update capture sequence or visible rejection issue.
 * @param recover - retry the original outbox through current owner authorization.
 * @returns local admission evidence; Stop reports do not certify turn completion.
 */
export async function captureClaudeWork(domain: ScopeDomain, input: WorkHookInput, key: ClaudeScopeSessionKey,
  capture: ActiveWorkCapture, limits: ContributionLimits, signal: AbortSignal,
  save: (capture: ScopeContribution) => Promise<unknown>, recover: () => Promise<boolean>): Promise<ClaudeScopeHookResult> {
  const source = capture.source
  const invitation = capture.invitation
  const leases = domain.table('work_leases')
  const promptKey = keyFor(key, capture, 'prompt')
  if (input.event === 'UserPromptSubmit') {
    await leases.delete(promptKey)
    signal.throwIfAborted()
    if (!source.stopReports || !input.promptId?.trim()) return omitted('prompt-not-authorized')
    if (!await recover()) return omitted('contribution-awaiting-owner')
    if (retainedLeaseCount(domain) >= limits.maxLeases) return omitted('tool-lease-limit')
    await leases.put(promptKey, { ...identity(key, capture), kind: 'prompt', promptId: input.promptId })
    return { output: {}, receipt: { status: 'leased' } }
  }
  if (input.event === 'StopFailure') {
    const prompt = leases.get(promptKey)
    if (prompt?.kind === 'prompt' && prompt.promptId === input.promptId) await leases.delete(promptKey)
    return omitted('stop-failure-report')
  }
  if (!await recover()) return omitted('contribution-awaiting-owner')
  const sequence = capture.sequence + 1
  if (!Number.isSafeInteger(sequence)) throw new Error('claude-scope: contribution sequence exhausted')
  const maxBytes = Math.min(limits.maxObservationBytes, invitation.grant.maxSampleBytes)
  let leaseKey: string
  let lease: Exclude<ScopeWorkLease, { kind: 'prompt' }> | undefined
  let sourceId: DevelopmentTaskObservedSourceId
  let result: ScopeContributionSample['result']
  if (input.event === 'Stop') {
    const prompt = leases.get(promptKey)
    if (!source.stopReports || prompt?.kind !== 'prompt' || prompt.promptId !== input.promptId || input.stop === undefined
      || !input.stop.text.trim()) return omitted('missing-current-prompt-lease')
    const textDigest = digestText(input.stop.text)
    leaseKey = keyFor(key, capture, 'Stop', prompt.promptId, textDigest, input.stop.active)
    sourceId = leaseKey.slice('work:'.length) as DevelopmentTaskObservedSourceId
    const retained = leases.get(leaseKey)
    if (retained !== undefined) {
      return { output: {}, receipt: { status: 'reused' } }
    }
    result = claudeStopReportResultSchema.parse({ kind: 'claude-stop-report', version: 7, text: input.stop.text,
      sha256: textDigest, stopHookActive: input.stop.active })
    const sample = { sourceId, sequence, result }
    lease = { ...identity(key, capture), kind: 'stop-report', promptId: prompt.promptId, textDigest,
      stopHookActive: input.stop.active, sample }
  } else {
    const tool = input.tool
    const argumentDigest = claudeScopeToolArgumentDigest(tool)
    if (argumentDigest === undefined) return omitted('unsupported-tool-input')
    const authorized = await authorize(tool, input.cwd, capture)
    signal.throwIfAborted()
    if (authorized.kind === 'omitted') return omitted(authorized.reason)
    leaseKey = keyFor(key, capture, 'tool', tool.id)
    // Restore and the serialized recovery validate each persisted key against its lease kind.
    const retained = leases.get(leaseKey) as Extract<ScopeWorkLease, { kind: 'tool' }> | undefined
    if (retained !== undefined && (retained.argumentDigest !== argumentDigest || retained.authorizedInputDigest !== authorized.inputDigest
      || retained.toolName !== tool.name)) return omitted('tool-lease-changed')
    if (input.event === 'PreToolUse') {
      if (retained === undefined) {
        if (retainedLeaseCount(domain) >= limits.maxLeases) return omitted('tool-lease-limit')
        await leases.put(leaseKey, { ...identity(key, capture), kind: 'tool', toolUseId: tool.id,
          toolName: authorized.toolName, argumentDigest, authorizedInputDigest: authorized.inputDigest })
      }
      return { output: {}, receipt: { status: 'leased' } }
    }
    if (retained === undefined) return omitted('missing-pre-tool-lease')
    const completionDigest = scopeDigest([input.event, tool.response ?? null, tool.error ?? null, tool.isInterrupt ?? null])
    if (retained.completionDigest !== undefined && (retained.completionDigest !== completionDigest || retained.terminal !== input.event)) return omitted('tool-completion-conflict')
    if (retained.sample !== undefined) {
      return { output: {}, receipt: { status: 'reused' } }
    }
    sourceId = scopeDigest([leaseKey, input.event, sequence]) as DevelopmentTaskObservedSourceId
    const fits = (value: ScopeContributionSample['result']) => Buffer.byteLength(JSON.stringify({ grant: invitation.grant, sourceId, sequence, result: value })) <= maxBytes
    const report = authorized.toolName === 'Bash'
      ? commandReport(input.event, tool, authorized.fields, fits) : renderClaudeScopeToolContribution(input, authorized, fits)
    if (report.kind === 'omitted') return omitted(report.reason)
    result = report
    lease = { ...retained, terminal: input.event, completionDigest }
  }
  signal.throwIfAborted()
  if (Buffer.byteLength(JSON.stringify({ grant: invitation.grant, sourceId, sequence, result })) > maxBytes) {
    await save({ ...capture, issue: 'capacity' })
    return omitted('stop-report-exceeds-budget')
  }
  if (leases.get(leaseKey) === undefined && retainedLeaseCount(domain) >= limits.maxLeases) return omitted('tool-lease-limit')
  await save({ ...capture, sequence })
  signal.throwIfAborted()
  await leases.put(leaseKey, { ...lease, sample: { sourceId, sequence, result } })
  signal.throwIfAborted()
  if (!await recover()) return omitted('contribution-awaiting-owner')
  return { output: {}, receipt: { status: 'published' } }
}
