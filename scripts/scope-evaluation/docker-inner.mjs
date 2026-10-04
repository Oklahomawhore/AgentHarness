/** Container PID 1 converts bounded JSON lines to the reviewed runner's Node IPC channel. */
import { spawn } from 'node:child_process'

const [mode, target, timeout, wire, diagnostic] = process.argv.slice(2)
const maxWireBytes = Number(wire)
const maxDiagnosticBytes = Number(diagnostic)
let diagnosticBytes = 0
let wireBytes = 0
let input = Buffer.alloc(0)
const child = spawn(process.execPath, ['--permission', '--allow-fs-read=/work', '--allow-fs-read=/runtime/runner.mjs',
  ...(mode === 'tests' ? ['--allow-fs-write=/work/qa/verdict.json'] : []), '/runtime/runner.mjs', mode, target], {
  cwd: '/work', env: { HOME: '/tmp', LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
function fail(message) {
  process.stderr.write(`${message}\n`)
  child.kill('SIGKILL')
  process.exitCode = 1
}
const timer = setTimeout(() => fail('Docker program deadline exceeded'), Number(timeout))
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  diagnosticBytes += chunk.length
  if (diagnosticBytes > maxDiagnosticBytes) { fail('Docker program diagnostic limit exceeded'); return }
  process.stderr.write(chunk)
})
child.on('error', error => fail(error.message))
child.on('message', message => {
  const encoded = `${JSON.stringify(message)}\n`
  wireBytes += Buffer.byteLength(encoded)
  if (wireBytes > maxWireBytes) { fail('Docker program wire limit exceeded'); return }
  process.stdout.write(encoded)
})
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk])
  for (;;) {
    const newline = input.indexOf(10)
    if (newline < 0) break
    if (newline > maxWireBytes) { fail('Docker program input limit exceeded'); return }
    const line = input.subarray(0, newline).toString('utf8')
    input = input.subarray(newline + 1)
    try { child.send(JSON.parse(line), error => { if (error) fail(error.message) }) }
    catch (error) { fail(String(error)); return }
  }
  if (input.length > maxWireBytes) fail('Docker program incomplete input limit exceeded')
})
process.stdin.on('end', () => child.kill('SIGKILL'))
child.on('close', (code, signal) => {
  clearTimeout(timer)
  process.stdin.destroy()
  process.exitCode ??= signal === null && code !== null ? code : 1
})
