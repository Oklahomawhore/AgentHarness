/** Controlled offline fixture launcher, never a public app or an untrusted-code sandbox. */
import { run } from 'node:test'
import { pathToFileURL } from 'node:url'

function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()))
}
function errorData(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'EXECUTION_ERROR', message: String(error?.message ?? error).slice(0, 1000) }
}

// Losing the owning parent ends even a controlled fixture that left an interval running.
process.once('disconnect', () => process.exit(process.exitCode ?? 1))
const [mode, target] = process.argv.slice(2)
if (mode === 'client') {
  try {
    const client = await import(pathToFileURL(target).href)
    if (typeof client.submit !== 'function') throw new Error('missing submit export')
    process.on('message', message => {
      if (message?.kind === 'stop') { process.exitCode = 0; process.disconnect(); return }
      if (message?.kind !== 'call') return
      Promise.resolve().then(() => client.submit(message.payload)).then(
        value => send({ kind: 'result', id: message.id, ok: true, value }),
        error => send({ kind: 'result', id: message.id, ok: false, error: errorData(error) }),
      ).catch(() => { process.exitCode = 1; process.disconnect() })
    })
    await send({ kind: 'ready' })
  } catch (error) {
    await send({ kind: 'startup-error', error: errorData(error) })
    process.exitCode = 1
    process.disconnect()
  }
} else if (mode === 'tests') {
  // The facade references IPC only while a request is pending; idle IPC must not hold node:test open.
  process.channel?.unref()
  const result = { testCount: 0, passed: 0, assertionFailures: 0, invalidFailures: 0, skipped: 0, todo: 0, errors: [] }
  for await (const event of run({ files: [target], isolation: 'none', concurrency: false })) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    result.testCount++
    if (event.data.skip) result.skipped++
    if (event.data.todo) result.todo++
    if (event.type === 'test:pass') { result.passed++; continue }
    let error = event.data.details?.error
    while (error?.cause) error = error.cause
    if (error?.code === 'ERR_ASSERTION') result.assertionFailures++
    else if (event.data.details?.error?.failureType !== 'subtestsFailed') result.invalidFailures++
    result.errors.push(errorData(error))
  }
  await send({ kind: 'report', value: result })
  process.exitCode = result.assertionFailures || result.invalidFailures ? 1 : 0
  process.disconnect()
} else {
  throw new Error('unknown controlled runner mode')
}
