/** Keyless summary adapter for the real Web settings/restart acceptance. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'scope-context-settings-fixture'
export const inject = ['llm']

/** Register a distinct controlled summary route without changing the production backend or ordinary Agent route.
 * @param ctx - The actual Web Host context.
 * @param config - Built LLM module, isolated audit root, and fixture-owned output.
 */
export async function apply(ctx, config) {
  const { LlmAdapter } = await import(config.llmModule)
  const observed = []
  await writeFile(config.output, JSON.stringify({ requests: observed }) + '\n', { flag: 'wx', mode: 0o600 })
  class SummaryAdapter extends LlmAdapter {
    providerInfo() { return { id: 'settings-summary-fixture', name: 'Settings summary fixture' } }
    async listModels() { return [{ provider: 'settings-summary-fixture', id: 'summary', name: 'Controlled summary' }] }
    async resolveModel(provider, model) {
      assert.equal(provider, 'settings-summary-fixture')
      assert.equal(model, 'summary')
      return { provider, id: model, name: 'Controlled summary', contextWindow: 128000, defaultMaxTokens: 2048 }
    }
    async *stream(options) {
      assert.equal(options.purpose, 'context-summary')
      assert.equal(options.sessionId, 'scope-context-audit')
      assert.deepEqual(options.tools ?? [], [])
      assert.equal(observed.length, 0, 'this scenario permits one actual auxiliary request')
      const files = (await readdir(config.auditRoot, { recursive: true })).filter(file => file.endsWith('.jsonl'))
      assert.equal(files.length, 1)
      const rows = (await readFile(join(config.auditRoot, files[0]), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
      const event = rows.findLast(row => row.type === 'context/semantic-request')
      assert.ok(event, 'the auxiliary reservation is durable before dispatch')
      assert.deepEqual(event.data.messages, options.messages)
      assert.equal(event.data.system, options.system)
      assert.equal(event.data.call.provider, options.provider)
      assert.equal(event.data.call.model, options.model)
      const input = JSON.parse(options.messages[0].content.map(block => block.text ?? '').join('\n'))
      const selected = input.sources.filter(source => source.body.includes(config.marker))
      assert.equal(selected.length, 1, 'the real Task publication reaches the selected backend')
      const output = { version: 1,
        decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: source === selected[0] })),
        updates: [{ text: 'The authorized Task contains the settings acceptance fact.',
          sources: [{ sourceId: selected[0].sourceId, quote: config.marker }] }],
      }
      observed.push({ provider: options.provider, model: options.model, purpose: options.purpose,
        sessionId: options.sessionId, messages: options.messages, system: options.system,
        requestSeq: event.seq, sourceId: selected[0].sourceId, output })
      await writeFile(config.output, JSON.stringify({ requests: observed }, null, 2) + '\n')
      const text = JSON.stringify(output)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 64, outputTokens: 32 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['settings-summary-fixture'], new SummaryAdapter()), 'keyless settings summary route')
}
