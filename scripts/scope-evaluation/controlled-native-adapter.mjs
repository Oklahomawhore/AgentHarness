/** Reviewed tool-call program used only to calibrate a real native loop; no model inference or usage is fabricated. */
import { isDeepStrictEqual } from 'node:util'

/** Create an adapter that records the actual request and executes the same program in every condition.
 * @param dependencies Public LlmAdapter and Session constructors.
 * @param options Private program, owning agent lookup, and request recorder.
 * @returns A controlled adapter instance; missing usage remains unknown.
 */
export function createControlledNativeAdapter({ LlmAdapter, Session }, { program, agent, requests }) {
  return new class extends LlmAdapter {
    async * stream(request) {
      const current = agent()
      const events = current.session.snapshotEvents()
      const detached = Session.create(current.session.id, events, current.session.header)
      if (!isDeepStrictEqual(detached.deriveMessages(), request.messages)) {
        throw new Error('actual request does not reconstruct from its Session prefix')
      }
      const index = requests.length
      requests.push({ index, messages: request.messages, tools: request.tools ?? [], eventCount: events.length,
        sourceSeqs: events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'scope-agent-context'
          && request.messages.some(message => isDeepStrictEqual(message, event.data))).map(event => event.seq), reconstructed: true })
      const call = program[index]
      if (call !== undefined) {
        const id = `controlled-${index}`
        const args = JSON.stringify(call.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (index === program.length) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Controlled runner finished its file operations.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else throw new Error('controlled program requested an unregistered extra step')
    }
  }()
}
