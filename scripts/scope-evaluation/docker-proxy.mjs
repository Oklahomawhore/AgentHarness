/** Host IPC bridge; only the parent owns container creation and removal. */
import { spawn } from 'node:child_process'

const { dockerPath, base, id, maxWireBytes, maxDiagnosticBytes } = JSON.parse(process.argv[2])
let child
let buffer = Buffer.alloc(0)
let diagnostics = 0
let outgoing = 0
function fail(message) {
  process.stderr.write(`${message}\n`)
  child?.kill('SIGKILL')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
process.once('disconnect', () => { child?.kill('SIGKILL'); process.exit(process.exitCode ?? 1) })
process.on('message', message => {
  if (child === undefined) {
    if (message?.kind !== 'bridge-start') { fail('Missing Docker bridge start'); return }
    child = spawn(dockerPath, [...base, 'start', '--attach', '--interactive', id], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C', TZ: 'UTC' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', error => fail(error.message))
    child.stderr.on('data', chunk => {
      diagnostics += chunk.length
      if (diagnostics > maxDiagnosticBytes) { fail('Docker diagnostic byte limit exceeded'); return }
      process.stderr.write(chunk)
    })
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const newline = buffer.indexOf(10)
        if (newline < 0) break
        if (newline > maxWireBytes) { fail('Docker message byte limit exceeded'); return }
        const line = buffer.subarray(0, newline).toString('utf8')
        buffer = buffer.subarray(newline + 1)
        try {
          const value = JSON.parse(line)
          outgoing += newline
          if (outgoing > maxWireBytes) throw new Error('Docker aggregate wire byte limit exceeded')
          if (process.connected) process.send(value, error => { if (error) fail(error.message) })
        } catch (error) { fail(String(error)); return }
      }
      if (buffer.length > maxWireBytes) fail('Docker unterminated message byte limit exceeded')
    })
    child.on('close', (code, signal) => {
      if (buffer.length !== 0) { fail('Docker closed with an incomplete message'); return }
      process.exitCode = signal === null && code !== null ? code : 1
      if (process.connected) process.disconnect()
    })
    return
  }
  const encoded = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(encoded) > maxWireBytes) { fail('Docker input byte limit exceeded'); return }
  child.stdin.write(encoded, error => { if (error) fail(error.message) })
})
