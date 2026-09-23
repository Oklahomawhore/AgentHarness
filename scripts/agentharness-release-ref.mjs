/** Validate the tag and source commit selected for an AgentHarness release. */
import { appendFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseRef = /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u

/**
 * @param {string} ref GitHub's full Git ref.
 * @returns {string} The stable semantic version without its `v` prefix.
 */
export function versionFromReleaseRef(ref) {
  const match = releaseRef.exec(ref)
  if (!match) throw new Error(`AgentHarness release requires a stable vMAJOR.MINOR.PATCH tag: ${ref}`)
  return match[1]
}

/**
 * @param {string} commit Commit supplied by the tag push event.
 * @param {{ cwd?: string, mainRef?: string }} options Git checkout and main ref to verify.
 * @returns {void}
 */
export function assertReleaseCommitOnMain(commit, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const mainRef = options.mainRef ?? 'refs/remotes/origin/main'
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  if (commit !== head) throw new Error(`Tag event commit ${commit} differs from checked-out commit ${head}`)
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, mainRef], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Release commit ${commit} is not reachable from ${mainRef}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = versionFromReleaseRef(process.env.GITHUB_REF)
  assertReleaseCommitOnMain(process.env.GITHUB_SHA)
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required for AgentHarness release identity')
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}
