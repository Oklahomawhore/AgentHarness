/** Executes only a reviewed public project test; no hidden oracle, client mutation, or service facts are supplied. */
import { run } from 'node:test'
const [target] = process.argv.slice(2)
if (target === undefined) throw new Error('public test path is required')
const report = { tests: 0, passed: 0, assertionFailures: 0, invalidFailures: 0, skipped: 0 }
for await (const event of run({ files: [target], isolation: 'none', concurrency: false })) {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
  report.tests++
  if (event.data.skip || event.data.todo) report.skipped++
  if (event.type === 'test:pass') report.passed++
  else {
    let error = event.data.details?.error
    while (error?.cause) error = error.cause
    if (error?.code === 'ERR_ASSERTION') report.assertionFailures++
    else report.invalidFailures++
  }
}
process.stdout.write(JSON.stringify(report) + '\n')
process.exitCode = report.assertionFailures || report.invalidFailures ? 1 : 0
