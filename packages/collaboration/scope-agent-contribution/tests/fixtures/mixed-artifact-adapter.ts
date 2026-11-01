/** Controlled artifact replies derived only from admitted messages and the recipient's public baseline. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { semanticSummaryInputSchema } from '@deepseek-ai/dsh-development-task-context/src/semantic-schema.ts'
import { parsePolicy, sealDataArtifact }
  from '../../../../../scripts/scope-evaluation/data-artifacts.ts'
import { mixedCalibrationEvidence, mixedCalibrationSummary, mixedPublicCases } from '../../../../../scripts/scope-evaluation/mixed-calibration.ts'
import { toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'

/** Decode only actual ordinary content, preserving the existing Loader calibration API.
 * @param messages - Actual ordinary model request; source metadata is never read.
 * @returns Admitted policy text and command result without inferred missing evidence.
 */
export function mixedVisibleEvidence(messages: GenerateOptions['messages']) {
  return mixedCalibrationEvidence(messages.map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')))
}

/** Script real Write calls using only a role's public baseline and the current ordinary request.
 * @param role - Existing human responsibility; no condition or expected grade is supplied.
 * @param workspace - Recipient-owned directory containing the public initial project.
 * @param artifactPath - Role's authorized policy or QA output path.
 * @param verificationPath - Role's separate authorized command-evidence output path.
 * @returns Two model replies; the caller appends the ordinary final completion.
 */
export function mixedArtifactReplies(role: 'B' | 'C', workspace: string, artifactPath: string, verificationPath: string) {
  return [
    (options: GenerateOptions): StreamChunk[] => {
      const baseline = parsePolicy(sealDataArtifact(readFileSync(join(workspace, 'public/payment-policy.json'), 'utf8')))
      const visible = mixedVisibleEvidence(options.messages)
      const maxRetries = visible.policy.flatMap(text => [...text.matchAll(/maxRetries: (\d+)/g)].map(match => Number(match[1]))).at(-1)
      const policy = { ...baseline, ...(maxRetries === undefined ? {} : { maxRetries }) }
      const artifact = role === 'B' ? policy : mixedPublicCases(policy)
      return toolCallResponse('mixed-artifact-write', 'write',
        { file_path: artifactPath, content: JSON.stringify(artifact, null, 2) + '\n' })
    },
    (options: GenerateOptions): StreamChunk[] => {
      const { exitCode } = mixedVisibleEvidence(options.messages)
      const artifact = { version: 1, status: exitCode === null ? 'unavailable' : exitCode === 0 ? 'passed' : 'failed', exitCode }
      return toolCallResponse('mixed-verification-write', 'write',
        { file_path: verificationPath, content: JSON.stringify(artifact, null, 2) + '\n' })
    },
  ]
}

/** Controlled relevance replies cite only actual authorized policy reports; they do not establish model quality. */
export class MixedArtifactSummaryAdapter extends LlmAdapter {
  readonly calls: { messages: GenerateOptions['messages']; response: unknown }[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const block = options.messages[0]?.content[0]
    if (options.purpose !== 'context-summary' || block?.type !== 'text') throw new Error('Expected actual summary input')
    const input = semanticSummaryInputSchema.parse(JSON.parse(block.text) as unknown)
    const response = mixedCalibrationSummary(input.sources)
    this.calls.push({ messages: structuredClone(options.messages), response })
    const text = JSON.stringify(response)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
