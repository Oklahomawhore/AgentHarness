/** Experimental-package publication and dependency constraints. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkDshFamilyVersion,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspaceManifest,
  expectedDshPackageFiles,
  type PackageManifest,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

const publicExperimental: WorkspaceManifest = {
  dir: 'packages/experimental/agent-team',
  manifest: {
    name: '@deepseek-ai/dsh-experimental-agent-team',
    publishConfig: { access: 'public' },
  },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it('requires public metadata only for the Agent Teams exceptions', () => {
    expect(checkExperimentalManifest(publicExperimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...publicExperimental,
      manifest: {
        name: '@deepseek-ai/dsh-experimental-agent-team',
        private: true,
      },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-agent-team: public experimental package must not set "private": true',
      '@deepseek-ai/dsh-experimental-agent-team: public experimental package must set publishConfig.access to "public"',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('dsh family version coherence', () => {
  it('rejects a package carrying a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh-http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('rejects the root-named CLI app on a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh: package.json version must match root version 0.1.2-rc.1')
  })

  it('accepts a manifest carrying the shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-rc.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
  })

  it('leaves other sequences to their own version lines', () => {
    expect(checkDshFamilyVersion({ name: '@deepseek-ai/cordis', version: '4.0.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/node-addon-system', version: '0.1.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion({ version: '0.1.2-alpha.5' }, '0.1.2-rc.1')).toBeUndefined()
  })
})

describe('package payload constraints', () => {
  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })
})

describe('CLI publication assets', () => {
  const cli: WorkspaceManifest = {
    dir: 'apps/cli',
    manifest: JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8')) as PackageManifest,
  }
  const files = [
    'lib/*.js',
    'config/examples/scope-context/deadlines.cordis.yml',
    'config/examples/scope-context/semantic.cordis.yml',
  ]

  it('publishes the CLI runtime and the two selected scope-context overlays', () => {
    expect(checkWorkspaceManifest({ ...cli, manifest: { ...cli.manifest, files } })).toEqual([])
  })

  it.each<[string, string[]]>([
    ['an extra asset', [...files, 'config/examples/scope-context/extra.cordis.yml']],
    ['a directory glob', ['lib/*.js', 'config/examples/scope-context/*.yml']],
    ['a missing overlay', files.slice(0, 2)],
  ])('rejects %s in the CLI publication list', (_name, invalidFiles) => {
    expect(checkWorkspaceManifest({ ...cli, manifest: { ...cli.manifest, files: invalidFiles } })).toEqual([
      `apps/cli/package.json: @deepseek-ai/dsh: package.json files must be ${JSON.stringify(files)}`,
    ])
  })
})

describe('published auxiliary entry payloads', () => {
  it('includes the authenticated local-access entry beside both connection faces', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-client-connection',
      exports: {
        './local-access': { default: './lib/local-access.js' },
        './client': { default: './lib/client.js' },
      },
    })).toEqual([
      'lib/index.js',
      'lib/local-access.js',
      'lib/client.js',
      'lib/types/**/*.d.ts',
    ])
  })

  it('includes the stdio entry, profile patch, and private shared bridge chunks', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-agentharness-bridge',
      exports: { './stdio': './lib/stdio.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'lib/stdio.js',
      'cordis.patch.yml',
      'lib/chunks/*.js',
      'lib/types/**/*.d.ts',
    ])
  })

  it.each(['development-room-storage-domain', 'development-room-context-storage-domain'])(
    'retains the schema chunk shared by the runtime and invariant for %s', (name) => {
      expect(expectedDshPackageFiles({
        name: `@deepseek-ai/dsh-${name}`,
        exports: { './invariant': { default: './lib/invariant.js' } },
      })).toEqual([
        'lib/index.js',
        'lib/invariant.js',
        'lib/schema-*.js',
        'lib/types/**/*.d.ts',
      ])
    },
  )

  it('does not infer auxiliary bundles from a subpath targeting the emitted tree', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-other',
      exports: {
        './local-access': { default: './lib/types/local-access.js' },
        './stdio': { default: './lib/types/stdio.js' },
      },
    })).toEqual(['lib/index.js', 'lib/types/**/*.js', 'lib/types/**/*.d.ts'])
  })

  it('does not add auxiliary entries or private chunk globs to an unrelated package', () => {
    expect(expectedDshPackageFiles({ name: '@deepseek-ai/dsh-other' }))
      .toEqual(['lib/index.js', 'lib/types/**/*.d.ts'])
  })
})
