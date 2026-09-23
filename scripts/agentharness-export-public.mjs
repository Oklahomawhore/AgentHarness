#!/usr/bin/env node
/** Export reviewed working-tree source without Git history or local credentials. */
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, process.argv[2] ?? 'dist/agentharness-public-source')
try {
  if (output === root || root.startsWith(`${output}${sep}`)) throw new Error('output cannot contain the source repository')
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString().split('\0').filter(Boolean)
  const names = [...new Set(files)].filter(name => !/(^|\/)\.env(?:\.|$)/u.test(name) || name.endsWith('.env.example'))
  let localSecrets = []
  try {
    localSecrets = Object.entries(parseEnv(await readFile(resolve(root, '.env'), 'utf8')))
      .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/u.test(key) && value.length >= 16).map(([, value]) => value)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const blocked = []
  const reviewed = []
  for (const name of names) {
    const path = resolve(root, name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      if (!(await realpath(path)).startsWith(`${root}${sep}`)) blocked.push(`${name}: external symbolic link`)
      continue
    }
    const text = (await readFile(path)).toString('utf8')
    if (localSecrets.some(secret => text.includes(secret)) || /ark-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9-]{12,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) {
      blocked.push(`${name}: potential credential (value suppressed)`)
    }
    if (/\/Users\/jetcodery\/|gitee\.com\/AGENTHARNESS_2\//u.test(text)) reviewed.push(name)
  }
  if (blocked.length) throw new Error(`public export blocked:\n${blocked.join('\n')}`)
  // Exclusive directory creation prevents overwriting an earlier reviewed export.
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  for (const name of names) {
    const destination = resolve(output, name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(resolve(root, name), destination, { verbatimSymlinks: true })
  }
  const report = { files: names.length, historyIncluded: false, excluded: ['.env and .env.* except .env.example', 'Git metadata', 'ignored local artifacts'], remainingReferenceFiles: reviewed, scope: 'Current tracked and non-ignored working-tree files; heuristic and exact local-secret checks, not a proof that every secret is absent.' }
  await writeFile(`${output}.audit.json`, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Exported ${names.length} files to ${output}\nAudit: ${output}.audit.json\nRemaining personal/internal reference files: ${reviewed.length}\n`)
} catch (error) {
  process.stderr.write(`agentharness-export-public: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
