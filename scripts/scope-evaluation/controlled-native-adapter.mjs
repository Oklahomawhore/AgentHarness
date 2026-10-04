/** Reviewed tool-call program used only to calibrate a real native loop; no model inference or usage is fabricated. */
import { isDeepStrictEqual } from 'node:util'

/** Create an adapter that records the actual request and executes the same program in every condition.
 * @param dependencies Public LlmAdapter and Session constructors.
 * @param options Private program, owning agent lookup, and request recorder.
 * @returns A controlled adapter instance; missing usage remains unknown.
 */
export function createControlledNativeAdapter({ LlmAdapter, Session }, { program, agent, requests, beforeRequest }) {
  return new class extends LlmAdapter {
    async * stream(request) {
      await beforeRequest?.(requests.length, request.signal)
      recordNativeRequest(Session, agent(), request, requests)
      const index = requests.length - 1
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

/** Record the exact model request against a reconstructable native Session prefix.
 * @param Session Public detached Session constructor.
 * @param current Owning live Agent.
 * @param request Actual LLM request after context admission.
 * @param requests Caller-owned append-only evidence list.
 * @returns Recorded request, excluding credentials and transport signals.
 */
export function recordNativeRequest(Session, current, request, requests) {
  const events = current.session.snapshotEvents()
  const detached = Session.create(current.session.id, events, current.session.header)
  if (!isDeepStrictEqual(detached.deriveMessages(), request.messages)) {
    throw new Error('actual request does not reconstruct from its Session prefix')
  }
  const entry = { index: requests.length, messages: request.messages, tools: request.tools ?? [], eventCount: events.length,
    sourceSeqs: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'scope-agent-context'
      && request.messages.some(message => isDeepStrictEqual(message, event.data))).map(event => event.seq), reconstructed: true }
  requests.push(entry)
  return entry
}
