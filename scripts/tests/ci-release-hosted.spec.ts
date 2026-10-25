/** Hosted npm release rehearsals keep registry writes behind explicit protected publication. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  'runs-on': string
  if?: string
  needs?: string
  environment?: string
  concurrency?: Record<string, unknown>
  steps: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: Record<string, unknown>
  jobs: Record<string, Job>
}
const root = resolve(import.meta.dirname, '../..')

for (const [file, family, artifact] of [
  ['release.yml', 'dsh', 'dsh-npm-tarballs'],
  ['release-vendor.yml', 'vendor', 'vendor-npm-tarballs'],
] as const) {
  describe(file, () => {
    const source = readFileSync(resolve(root, '.github/workflows', file), 'utf8')
    const release = load(source) as Workflow
    const output = family === 'dsh' ? 'dist/npm' : 'dist/npm-vendor'
    const pack = release.jobs.pack!
    const publish = release.jobs.publish!

    it('keeps publication manual, disabled by default, and serialized through its environment', () => {
      expect(release.on).toEqual({ workflow_dispatch: { inputs: { publish: {
        description: `Publish the packed tarballs to npm. Must run from a ${family === 'dsh' ? 'dsh-v*' : 'vendor-*'} tag.`,
        required: true, type: 'boolean', default: false,
      } } } })
      expect(release.permissions).toEqual({ contents: 'read' })
      expect(release.concurrency['cancel-in-progress']).toBe(false)
      expect(Object.keys(release.jobs)).toEqual(['pack', 'publish'])
      expect(Object.values(release.jobs).map(job => job['runs-on'])).toEqual(['ubuntu-24.04', 'ubuntu-24.04'])
      expect(source).not.toMatch(/self-hosted|DSH_CI_FAILOVER|refs\/heads\/master/)
      expect(publish.if).toBe('inputs.publish')
      expect(publish.needs).toBe('pack')
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toEqual({ group: 'Release-publish', 'cancel-in-progress': false })
    })

    it('verifies the tag and packed install without exposing a registry token to build scripts', () => {
      expect(pack.steps[0]).toMatchObject({ uses: 'actions/checkout@v6', with: { 'fetch-depth': 0, 'persist-credentials': false } })
      expect(pack.steps).toContainEqual({ name: 'Verify release version',
        env: { RELEASE_PUBLISH: '${{ inputs.publish }}' }, run: `pnpm run release:verify --family ${family}` })
      expect(pack.steps.map(step => step.run)).toContain(`pnpm run release:pack --family ${family} --out ${output}`)
      expect(pack.steps.map(step => step.run)).toContain(`pnpm run release:verify-packed-install --family ${family} --from ${output}`
        + (family === 'dsh' ? ' --from dist/npm-vendor --from dist/npm-landlock' : ''))
      expect(pack.steps.at(-1)).toMatchObject({ uses: 'actions/upload-artifact@v4',
        with: { name: artifact, path: `${output}/*`, 'if-no-files-found': 'error' } })
      expect(JSON.stringify(pack)).not.toMatch(/secrets\.|release:publish/)
    })

    it('publishes the packed bytes without rebuilding or running install scripts', () => {
      expect(publish.steps.map(step => step.run)).toContain('pnpm install --frozen-lockfile --ignore-scripts')
      expect(publish.steps).toContainEqual({ uses: 'actions/download-artifact@v4', with: { name: artifact, path: output } })
      const writes = publish.steps.filter(step => JSON.stringify(step).includes('secrets.'))
      expect(writes).toEqual([{ name: 'Publish tarballs', env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' },
        run: `pnpm run release:publish --family ${family} --from ${output}` }])
      expect(publish.steps.map(step => step.run).join('\n')).not.toMatch(/pnpm run (?:build|release:pack)/)
    })
  })
}
