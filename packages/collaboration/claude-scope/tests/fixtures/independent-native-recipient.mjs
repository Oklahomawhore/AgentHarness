/** Production native loop in a real dsh fixture; only the external model response is controlled. */

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import ScopeAgentContext from '@deepseek-ai/dsh-scope-agent-context'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Mount an authenticated observation route; no fixture route publishes source facts. */
export async function mountNativeRecipient(ctx) {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ScopeAgentContext, { maxContextBytes: 8000, coalesceMs: 1, retryDelayMs: 10000 })
  const llm = ctx.get('llm')
  const agents = ctx.get('agents')
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  const requests = []
  const listeners = new Set()
  class RecordingAdapter extends LlmAdapter {
    async * stream(options) {
      requests.push({ messages: options.messages })
      for (const notify of [...listeners]) notify()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded authorized context' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  llm.registerAdapter(['fixture'], new RecordingAdapter())
  const { agent } = await agents.create({
    sessionId: SessionId('independent-native-recipient'), agentOptions: { provider: 'fixture', model: 'fixture' },
  })
  const lifetime = new AbortController()
  const operations = new Set()
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'scope-agent-context/evaluation') return
    for (const notify of [...listeners]) notify()
  })
  const waitForObservation = async (count, suppressedRevision) => {
    const ready = () => requests.length >= count && (suppressedRevision === undefined
      || agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
        && event.data.decision === 'suppress-unchanged' && event.data.projection.taskRevision === suppressedRevision))
    if (!ready()) await new Promise((resolve, reject) => {
      const clean = () => { listeners.delete(check); lifetime.signal.removeEventListener('abort', abort) }
      const check = () => { if (ready()) { clean(); resolve() } }
      const abort = () => { clean(); reject(new Error('native observation cancelled')) }
      lifetime.signal.throwIfAborted()
      listeners.add(check)
      lifetime.signal.addEventListener('abort', abort, { once: true })
      check()
    })
    await agent.whenIdle()
    return { agentId: agent.id, requests, events: agent.session.snapshotEvents() }
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/fixture/native', handler(request, response) {
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) { response.writeHead(rejection); response.end(); return }
    const operation = (async () => {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 1024) throw new Error('native observation request too large')
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > 8) throw new Error('invalid request count')
      if (input.suppressedRevision !== undefined && (!Number.isSafeInteger(input.suppressedRevision) || input.suppressedRevision < 1)) {
        throw new Error('invalid suppressed revision')
      }
      const state = await waitForObservation(input.count, input.suppressedRevision)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(state))
    })()
    operations.add(operation)
    void operation.catch(() => {
      response.statusCode = 500
      response.end('native observation failed')
    }).finally(() => operations.delete(operation))
  } }), 'native fixture: authenticated request observations')
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(operations)
  }, 'native fixture: observation quiescence')
}
