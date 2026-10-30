/** Release family discovery, publish order, tag naming, and the bump judgements. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialClientBuildEnvironment, writeClientBuildRecord } from '../client-build-environment.ts'
import { releaseFamily, type ReleaseMember } from './families.ts'
import { compareVersions, nextVendorVersion, planShared } from './bump.ts'

/**
 * A release member standing in for a manifest on disk.
 * @param directory - repository-relative package directory.
 * @param name - package name.
 * @param manifest - manifest fields the subject reads.
 * @returns The member.
 */
function member(directory: string, name: string, manifest: Record<string, unknown> = {}): ReleaseMember {
  return { directory, name, version: '0.0.1', manifest }
}

const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildFixture(environment: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-build-'))
  roots.push(root)
  write(join(root, 'package.json'), `${JSON.stringify({ version: environment.DSH_CLIENT_VERSION ?? '0.0.1' })}\n`)
  write(join(root, 'apps/web/dist/index.html'), '<main></main>')
  write(join(root, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(root, environment)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('release families', () => {
  it('publishes Agent Teams while excluding private experimental packages', () => {
    const members = releaseFamily('dsh').members(resolve(import.meta.dirname, '../..'))

    expect(members
      .filter(member => member.directory.startsWith('packages/experimental/'))
      .map(member => member.name)).toEqual([
      '@deepseek-ai/dsh-experimental-agent-team-profile',
      '@deepseek-ai/dsh-experimental-agent-team-web-profile',
      '@deepseek-ai/dsh-experimental-agent-team',
      '@deepseek-ai/dsh-experimental-client-ui-agent-team',
      '@deepseek-ai/dsh-experimental-tool-agent-team',
    ])
    expect(members.map(member => member.name)).not.toContain('@deepseek-ai/dsh-experimental-inspector')
  })

  it('excludes private applications from the publish set', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-release-private-'))
    roots.push(root)
    write(join(root, 'apps/public/package.json'), '{"name":"@deepseek-ai/dsh-public","version":"0.0.1"}\n')
    write(join(root, 'apps/private/package.json'), '{"name":"@deepseek-ai/dsh-private","version":"0.0.1","private":true}\n')

    expect(releaseFamily('dsh').members(root).map(entry => entry.name)).toEqual(['@deepseek-ai/dsh-public'])
  })

  it.each(['dsh', 'vendor'])('refuses a %s release selected entirely from private manifests', (id) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-release-unpublishable-'))
    roots.push(root)
    const manifest = id === 'dsh' ? 'apps/private/package.json' : 'vendor/private/package.json'
    write(join(root, manifest), JSON.stringify({ name: '@deepseek-ai/private', version: '0.0.1', private: true }))

    expect(() => releaseFamily(id).members(root)).toThrow(`release family ${id} matched no publishable manifests`)
  })

  it('bumps private dsh workspaces without adding release tags', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-release-version-'))
    roots.push(root)
    write(join(root, 'package.json'), '{"version":"0.0.1"}\n')
    write(join(root, 'apps/desktop/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/experimental/prototype/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/core/unselected/package.json'), '{"version":"0.0.1"}\n')

    const dsh = releaseFamily('dsh')
    const published = member('packages/core/published', '@deepseek-ai/dsh-published')
    const { planned } = planShared(dsh, root, [published], '0.0.2')

    expect(planned.map(entry => ({ path: entry.manifestPath, tag: entry.tag }))).toEqual([
      { path: 'package.json', tag: undefined },
      { path: 'packages/core/published/package.json', tag: 'dsh-v0.0.2' },
      { path: 'apps/desktop/package.json', tag: undefined },
      { path: 'packages/experimental/prototype/package.json', tag: undefined },
    ])
  })

  it.each(['0.0.2-alpha.1', '0.0.2-canary.1', '0.0.2-rc.1'])(
    'accepts the explicit dsh prerelease version %s',
    (version) => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-release-prerelease-'))
      roots.push(root)
      write(join(root, 'package.json'), '{"version":"0.0.1"}\n')

      const dsh = releaseFamily('dsh')
      const published = member('packages/core/published', '@deepseek-ai/dsh-published')
      const plan = planShared(dsh, root, [published], version)

      expect(plan.version).toBe(version)
      expect(plan.planned[1]?.tag).toBe(`dsh-v${version}`)
    },
  )

  it('names one tag for the whole dsh family and one per vendored package', () => {
    const dsh = releaseFamily('dsh')
    const vendor = releaseFamily('vendor')
    const cli = member('apps/cli', '@deepseek-ai/dsh')
    const cordis = { ...member('vendor/cordis', '@deepseek-ai/cordis'), version: '4.0.1' }

    expect(dsh.tagFor(cli)).toBe('dsh-v0.0.1')
    expect(vendor.tagFor(cordis)).toBe('vendor-cordis-v4.0.1')
    // The prefix is constructed, not recovered from a tag: a version with a
    // hyphen would defeat any suffix-stripping.
    expect(vendor.tagPrefixFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v')
    expect(vendor.tagFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v4.0.0-rc.7')
  })

  it('assigns alpha and canary dist-tags only to dsh releases', () => {
    const dsh = releaseFamily('dsh')
    const vendor = releaseFamily('vendor')

    expect(dsh.distTagForVersion('0.0.2-alpha.1')).toBe('alpha')
    expect(dsh.distTagForVersion('0.0.2-canary.1')).toBe('canary')
    expect(dsh.distTagForVersion('0.0.2-rc.1')).toBe('next')
    expect(dsh.distTagForVersion('0.0.2')).toBeUndefined()
    expect(vendor.distTagForVersion('4.0.1-alpha.1')).toBe('next')
    expect(vendor.distTagForVersion('4.0.1-canary.1')).toBe('next')
  })

  it('rejects a family whose members disagree on the shared version', () => {
    const dsh = releaseFamily('dsh')
    const members = [member('apps/cli', '@deepseek-ai/dsh'), { ...member('apps/web', '@deepseek-ai/dsh-web-frontend'), version: '0.0.2' }]

    expect(() => { dsh.verifyVersions(members) }).toThrow(/must share one version/)
    expect(() => { dsh.verifyVersions([members[0]!]) }).not.toThrow()
  })

  it('accepts independent vendored versions and rejects an unpublishable one', () => {
    const vendor = releaseFamily('vendor')
    const members = [
      { ...member('vendor/cordis', '@deepseek-ai/cordis'), version: '4.0.1' },
      { ...member('vendor/cosmokit', '@deepseek-ai/cosmokit'), version: '1.8.2' },
    ]

    expect(() => { vendor.verifyVersions(members) }).not.toThrow()
    expect(() => { vendor.verifyVersions([{ ...members[0]!, version: 'latest' }]) }).toThrow(/unpublishable version/)
  })

  it('requires a current official client build only for dsh artifacts', () => {
    const dsh = releaseFamily('dsh')
    const vendor = releaseFamily('vendor')
    const officialEnvironment = officialClientBuildEnvironment(resolve(import.meta.dirname, '../..'))
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', officialEnvironment.DSH_CLIENT_COMMIT_HASH)
    const official = buildFixture(officialEnvironment)
    const defaultBuild = buildFixture({})
    const missing = join(defaultBuild, 'missing')
    write(join(missing, 'package.json'), `${JSON.stringify({ version: officialEnvironment.DSH_CLIENT_VERSION })}\n`)

    expect(() => { dsh.verifyBuildArtifacts(official) }).not.toThrow()
    expect(() => { dsh.verifyBuildArtifacts(defaultBuild) }).toThrow(/DSH_CLIENT_TITLE/)
    expect(() => { dsh.verifyBuildArtifacts(missing) }).toThrow(/record.*missing/)
    expect(() => { vendor.verifyBuildArtifacts(missing) }).not.toThrow()

    write(join(official, 'packages/client/example/lib/client.js'), 'module.exports = { changed: true }\n')
    expect(() => { dsh.verifyBuildArtifacts(official) }).toThrow(/artifacts differ/)
  })

  it('publishes a dependency before its consumer, and orders ties by name', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/consumer', '@deepseek-ai/dsh-consumer', { dependencies: { '@deepseek-ai/dsh-library': 'workspace:^' } }),
      member('packages/a/library', '@deepseek-ai/dsh-library'),
      member('packages/a/zebra', '@deepseek-ai/dsh-zebra'),
    ]

    expect(dsh.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-library',
      '@deepseek-ai/dsh-consumer',
      '@deepseek-ai/dsh-zebra',
    ])
  })

  it('reports a runtime dependency cycle instead of emitting an arbitrary order', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/left', '@deepseek-ai/dsh-left', { dependencies: { '@deepseek-ai/dsh-right': 'workspace:^' } }),
      member('packages/a/right', '@deepseek-ai/dsh-right', { dependencies: { '@deepseek-ai/dsh-left': 'workspace:^' } }),
    ]

    expect(() => { dsh.publishOrder(members) }).toThrow(/dependency cycle/)
  })

  it('publishes a peer before its consumer', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/consumer', '@deepseek-ai/dsh-consumer', { peerDependencies: { '@deepseek-ai/dsh-zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@deepseek-ai/dsh-zebra'),
    ]

    // Name order alone would place the consumer first; the peer edge moves it.
    expect(dsh.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-zebra',
      '@deepseek-ai/dsh-consumer',
    ])
  })

  it('orders around a peer cycle rather than refusing to publish, and reports the edge it dropped', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/left', '@deepseek-ai/dsh-left', { peerDependencies: { '@deepseek-ai/dsh-right': 'workspace:^' } }),
      member('packages/a/right', '@deepseek-ai/dsh-right', { peerDependencies: { '@deepseek-ai/dsh-left': 'workspace:^' } }),
    ]

    const plan = dsh.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-right',
      '@deepseek-ai/dsh-left',
    ])
    // One of the two edges has to give, and which one it is belongs in the log.
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@deepseek-ai/dsh-right', peer: '@deepseek-ai/dsh-left' },
    ])
  })

  it('honours an install edge even when a peer cycle surrounds it', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/base', '@deepseek-ai/dsh-base', { peerDependencies: { '@deepseek-ai/dsh-consumer': 'workspace:^' } }),
      member('packages/a/consumer', '@deepseek-ai/dsh-consumer', {
        dependencies: { '@deepseek-ai/dsh-base': 'workspace:^' },
        peerDependencies: { '@deepseek-ai/dsh-base': 'workspace:^' },
      }),
    ]

    // The install edge is absolute: base publishes first, and the peer edge that
    // would reverse it is the one dropped.
    const plan = dsh.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-consumer',
    ])
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@deepseek-ai/dsh-base', peer: '@deepseek-ai/dsh-consumer' },
    ])
  })

  it('refuses an order that would publish a consumer before a dependency it installs', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/alpha', '@deepseek-ai/dsh-alpha', { peerDependencies: { '@deepseek-ai/dsh-bravo': 'workspace:^' } }),
      member('packages/a/bravo', '@deepseek-ai/dsh-bravo', { peerDependencies: { '@deepseek-ai/dsh-charlie': 'workspace:^' } }),
      member('packages/a/charlie', '@deepseek-ai/dsh-charlie', { dependencies: { '@deepseek-ai/dsh-alpha': 'workspace:^' } }),
    ]

    // A cycle of two peer edges closed by one install edge: dropping a peer edge
    // would order this, and the traversal drops the install edge instead. That
    // order would publish charlie before the alpha it installs, so it is refused
    // here rather than published.
    expect(() => { dsh.publishOrder(members) }).toThrow(/no publish order honours @deepseek-ai\/dsh-charlie -> @deepseek-ai\/dsh-alpha/)
  })

  it('ignores devDependencies when ordering', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/alpha', '@deepseek-ai/dsh-alpha', { devDependencies: { '@deepseek-ai/dsh-zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@deepseek-ai/dsh-zebra'),
    ]

    // A dev dependency is absent from the published package, so it must not move
    // the consumer behind it.
    expect(dsh.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-alpha',
      '@deepseek-ai/dsh-zebra',
    ])
  })

  it('applies the harness payload policy to dsh and keeps upstream payloads for vendored packages', () => {
    const dsh = releaseFamily('dsh')
    const vendor = releaseFamily('vendor')
    const harness = member('packages/a/library', '@deepseek-ai/dsh-library')
    const vendored = member('vendor/cordis', '@deepseek-ai/cordis')

    expect(() => { dsh.validatePayload(harness, ['package/lib/index.js', 'package/src/index.ts']) })
      .toThrow(/publishes source file/)
    expect(() => { vendor.validatePayload(vendored, ['package/lib/index.js', 'package/src/index.ts']) }).not.toThrow()
    expect(() => { vendor.validatePayload(vendored, []) }).toThrow(/empty tarball/)
  })

  it('drives the installed entry only for the family that publishes one', () => {
    expect(releaseFamily('dsh').installedEntry).toEqual({ packageName: '@deepseek-ai/dsh', binPath: 'lib/bin.js' })
    expect(releaseFamily('vendor').installedEntry).toBeUndefined()
  })

  it('rejects an unknown family identifier', () => {
    expect(() => { releaseFamily('native') }).toThrow(/unknown release family/)
  })
})

describe('vendored version baseline', () => {
  it('drops an upstream prerelease segment and increments the patch', () => {
    expect(nextVendorVersion('4.0.0-rc.7', undefined)).toBe('4.0.1')
    expect(nextVendorVersion('1.0.0-rc.5', undefined)).toBe('1.0.1')
    expect(nextVendorVersion('1.8.1', undefined)).toBe('1.8.2')
  })

  it('increments from the last tagged version when a re-sync restored a lower one', () => {
    // Upstream moved rc.7 -> rc.8 after this repository tagged 4.0.1;
    // incrementing the manifest alone would name 4.0.1 a second time.
    expect(nextVendorVersion('4.0.0-rc.8', '4.0.1')).toBe('4.0.2')
    expect(nextVendorVersion('4.1.0', '4.0.1')).toBe('4.1.1')
  })

  it('appends a rehearsal prerelease without consuming its release numbers', () => {
    // A rehearsal burns 4.0.1-rc.1 and leaves 4.0.1 free, so the stable release
    // that follows takes those same numbers instead of skipping to 4.0.2.
    expect(nextVendorVersion('4.0.0-rc.7', undefined, 'rc.1')).toBe('4.0.1-rc.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1', 'rc.2')).toBe('4.0.1-rc.2')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1')).toBe('4.0.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1')).toBe('4.0.2')
  })
})

describe('version precedence', () => {
  it('orders alpha, canary, and release-candidate versions by semver precedence', () => {
    expect(compareVersions('4.0.1-alpha.1', '4.0.1-canary.1')).toBeLessThan(0)
    expect(compareVersions('4.0.1-canary.1', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('ranks a release above the prerelease it follows', () => {
    // git --sort=v:refname disagrees, placing 4.0.1-rc.1 above 4.0.1, which is
    // why the newest published version is chosen here rather than by git.
    expect(compareVersions('4.0.1', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('compares numeric prerelease fields numerically', () => {
    expect(compareVersions('4.0.1-rc.10', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.2', '4.0.1-rc.10')).toBeLessThan(0)
  })

  it('ranks a numeric field below an alphanumeric one, and a shorter list below a longer', () => {
    expect(compareVersions('4.0.1-1', '4.0.1-alpha')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.2', '4.0.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1-rc.1')).toBe(0)
  })
})

describe('vendor release dry run', () => {
  it('advances unchanged tagged members together without writing versions or tags', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vendor-dry-run-'))
    roots.push(root)
    const manifests = [
      ['vendor/first/package.json', { name: '@deepseek-ai/first', version: '1.2.3', peerDependencies: { '@deepseek-ai/second': '^4.0.1' } }],
      ['vendor/second/package.json', { name: '@deepseek-ai/second', version: '4.0.1', peerDependencies: { '@deepseek-ai/first': '^1.2.3' } }],
    ] as const
    for (const [file, manifest] of manifests) write(join(root, file), `${JSON.stringify(manifest)}\n`)
    const hooks = join(root, 'empty-hooks')
    mkdirSync(hooks)
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      RELEASE_PUBLISH: 'false',
    }
    const run = (command: string, args: string[]): string => {
      const result = spawnSync(command, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 10000 })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    const git = (...args: string[]): string => run('git', [
      '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
      '-c', 'user.name=Release Fixture', '-c', 'user.email=release@example.invalid', ...args,
    ])
    git('init', '--quiet', '--template=', '--initial-branch=main')
    git('add', 'vendor')
    git('commit', '--quiet', '-m', 'Seed unchanged vendor members')
    git('tag', 'vendor-first-v1.2.3')
    git('tag', 'vendor-second-v4.0.1')
    const before = manifests.map(([file]) => readFileSync(join(root, file), 'utf8'))
    const tags = git('tag', '--list')

    const output = run(process.execPath, ['--import', import.meta.resolve('tsx/esm'), resolve(import.meta.dirname, 'bump.ts'),
      '--family', 'vendor', '--dry-run'])

    expect(output).toContain('vendor/first: 1.2.3 -> 1.2.4')
    expect(output).toContain('vendor/second: 4.0.1 -> 4.0.2')
    expect(output).toContain('release bump: dry run, nothing written')
    const verification = run(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      resolve(import.meta.dirname, 'verify.ts'), '--family', 'vendor'])
    expect(verification).toMatchInlineSnapshot(`
      "release verify: publish order for family vendor, 2 member(s):
        1  @deepseek-ai/second@4.0.1
        2  @deepseek-ai/first@1.2.3
      release verify: 1 peer declaration(s) publish unordered, because the peer cannot precede the package declaring it without contradicting a dependency edge or its own cycle. Peer compatibility still applies; installation may fail until the family is complete:
        @deepseek-ai/second -> @deepseek-ai/first
      release verify: family vendor, 2 member(s), 2 versions, publish order resolved, 1 peer declaration(s) unordered"
    `)
    expect(manifests.map(([file]) => readFileSync(join(root, file), 'utf8'))).toEqual(before)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('tag', '--list')).toBe(tags)
  }, 30000)
})
