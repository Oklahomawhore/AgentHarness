/** Controlled SSE replies use actual HTTP content and public role projects; they do not evaluate model quality. */
import { z } from 'zod'
import { parsePolicy, sealDataArtifact } from './data-artifacts.ts'
import { openDataHttpFixture, type DataHttpEnvelope, type DataHttpReply } from './data-http-fixture.ts'
import type { DataRoleProject } from './data-study.ts'
import { mixedCalibrationEvidence, mixedCalibrationSummary, mixedPublicCases } from './mixed-calibration.ts'

/** Explicit summary-capacity or ordinary-stream failure, after both original Sessions have worked. */
export interface MixedHttpFault {
  readonly omitMixedUsage?: boolean
  readonly cancelMixed?: AbortController
  readonly oversizedSummary?: boolean
}

/** Extract text only, excluding any non-content fields even when retained by an HTTP test double.
 * @param envelope - Actual provider HTTP body.
 * @returns One text string per message in original order.
 */
export function mixedHttpTexts(envelope: DataHttpEnvelope): string[] {
  return envelope.messages.map((message) => {
    if (typeof message.content === 'string') return message.content
    if (message.content === null) return ''
    return z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).parse(message.content)
      .flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
  })
}

/** Produce controlled ordinary and summary replies without receiving a condition, source program or parent oracle.
 * @param projects - Only the recipient-owned initial public projects.
 * @param fault - Explicit summary-capacity or first mixed-request accounting fault.
 * @returns A responder whose next action follows the actual HTTP transcript.
 */
export function createMixedHttpResponder(projects: Readonly<Record<'B' | 'C', DataRoleProject>>, fault: MixedHttpFault = {}) {
  return (envelope: DataHttpEnvelope): DataHttpReply => {
    const texts = mixedHttpTexts(envelope)
    if (envelope.messages.some((message, index) => message.role === 'system'
      && texts[index]?.includes('Summarize the supplied authorized work reports'))) {
      const input = z.object({ sources: z.array(z.object({ sourceId: z.string(), body: z.string(), attribution: z.unknown() })) })
        .parse(JSON.parse(z.string().parse(texts.at(-1))) as unknown)
      const summary = mixedCalibrationSummary(input.sources)
      const sources = input.sources.filter(source => summary.decisions
        .some(decision => decision.sourceId === source.sourceId && decision.relevant))
        .map((source) => {
          const quote = source.body.match(/maxRetries: \d+/g)?.at(-1)
          if (quote === undefined) throw new Error('controlled HTTP summary requires a literal retry limit in each relevant report')
          return { sourceId: source.sourceId, quote }
        })
      // Native local Tasks consume more of the fixed allowance; retain both policy citations in one short update.
      const compact = { version: 1, decisions: summary.decisions,
        updates: sources.length === 0 ? [] : [{ text: 'Apply the latest reported retry limit.'
          .repeat(fault.oversizedSummary === true ? 256 : 1), sources }] }
      return { kind: 'semantic', finish: 'stop', delta: { content: JSON.stringify(compact) } }
    }
    const roles = (['B', 'C'] as const).filter(role => texts.some(text => text.includes(projects[role].goal)))
    if (roles.length !== 1) throw new Error('ordinary HTTP request must identify exactly one public local responsibility')
    const role = roles[0]
    if (role === undefined) throw new Error('public local responsibility missing')
    const project = projects[role]
    const mixedStart = envelope.messages.findLastIndex((message, index) => message.role === 'user'
      && texts[index]?.includes('Continue your existing local responsibility using currently available authorized context.'))
    const phase = mixedStart < 0 ? 'initial' : 'mixed'
    const results = envelope.messages.slice(mixedStart < 0 ? 0 : mixedStart).filter(message => message.role === 'tool')
    const kind = `${role}-${phase}`
    if (results.length > 0) return { kind, finish: 'stop', delta: { content: 'Controlled local work completed.' } }
    let operations: { name: string; args: Readonly<Record<string, unknown>> }[]
    if (phase === 'initial') {
      operations = project.readableFiles.map(path => ({ name: 'evaluation_read', args: { path } }))
    } else {
      const initial = project.initialFiles['public/payment-policy.json']
      if (initial === undefined) throw new Error('public initial policy absent')
      const baseline = parsePolicy(sealDataArtifact(initial))
      const visible = mixedCalibrationEvidence(texts)
      const maxRetries = visible.policy.flatMap(text => [...text.matchAll(/maxRetries: (\d+)/g)].map(match => Number(match[1]))).at(-1)
      const policy = { ...baseline, ...(maxRetries === undefined ? {} : { maxRetries }) }
      const artifact = role === 'B' ? policy : mixedPublicCases(policy)
      const exitCode = visible.exitCode
      const verification = { version: 1, status: exitCode === null ? 'unavailable' : exitCode === 0 ? 'passed' : 'failed', exitCode }
      operations = [
        { name: 'evaluation_write', args: { path: project.artifactPath, text: JSON.stringify(artifact, null, 2) + '\n' } },
        { name: 'evaluation_write', args: { path: 'verification.json', text: JSON.stringify(verification, null, 2) + '\n' } },
      ]
    }
    return { kind, finish: 'tool_calls', delta: { tool_calls: operations.map((item, index) => ({
      index, id: `call-${role}-${phase}-${index}`, type: 'function',
      function: { name: item.name, arguments: JSON.stringify(item.args) },
    })) }, omitUsage: phase === 'mixed' && fault.omitMixedUsage === true,
    ...phase === 'mixed' && fault.cancelMixed !== undefined ? { cancel: fault.cancelMixed } : {} }
  }
}

/** Open a private loopback fixture before constructing routes; configure only public projects before dispatch.
 * @param fault - Explicit failure injection, never a condition-specific response.
 * @returns Awaited endpoint ownership, request evidence and a public-project configuration operation.
 */
export async function openMixedHttpFixture(fault: MixedHttpFault = {}) {
  let responder: ReturnType<typeof createMixedHttpResponder> | undefined
  const fixture = await openDataHttpFixture((envelope) => {
    if (responder === undefined) throw new Error('mixed HTTP fixture has no public projects')
    return responder(envelope)
  })
  return { ...fixture, configure(projects: Readonly<Record<'B' | 'C', DataRoleProject>>) {
    if (responder !== undefined) throw new Error('mixed HTTP fixture public projects already configured')
    responder = createMixedHttpResponder(projects, fault)
  } }
}
