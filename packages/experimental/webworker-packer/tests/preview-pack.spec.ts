/** Real browser-library and Mesh artifacts retain their deployment ownership during Worker packing. */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeBuiltins } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtins.ts'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { packVfsImage } from '../src/pack.ts'
import { composeProfile, configTrees, indexWorkspacePackages, staticPagePackages } from '../src/repository.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const workspaces = indexWorkspacePackages(root)
const fixtures: string[] = []
const pageOnlyPackages = new Set(['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives'])
const artifacts = [
  'packages/client/store/lib/index.js',
  'packages/client/ui-primitives/lib/index.js',
  'packages/collaboration/development-mesh-websocket/lib/index.js',
].every(path => existsSync(join(root, path)))

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function packHost(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-preview-owner-'))
  fixtures.push(directory)
  mkdirSync(join(directory, 'lib'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: '@fixture/host', type: 'module', exports: { '.': './lib/index.js' }, files: ['lib/index.js'],
    dependencies: Object.fromEntries([...pageOnlyPackages].map(name => [name, '*'])),
  }))
  writeFileSync(join(directory, 'lib/index.js'), source)
  const options = {
    config: '- name: "@fixture/host"\n', profile: 'preview-package-ownership',
    workspaces: new Map([...workspaces, ['@fixture/host', directory]]), resolveFrom: root, entries: [], pageOnlyPackages,
  }
  return packVfsImage(options)
}

// These are artifact-plane regressions: source-only coverage does not manufacture built bundles.
;(artifacts ? describe : describe.skip)('preview package ownership', () => {
  it('keeps real static Client libraries out of the Worker image without collecting browser devDependencies', () => {
    const result = packHost('export const hostReady = true\n')
    expect(result.missing).toEqual([])
    for (const name of pageOnlyPackages) {
      expect(result.packages.has(name)).toBe(false)
      expect(Object.keys(result.files).some(path => path.startsWith(`node_modules/${name}/`))).toBe(false)
    }
    expect(result.packages.has('immer')).toBe(false)
    expect(result.packages.has('shiki')).toBe(false)
    expect(result.files['node_modules/@fixture/host/lib/index.js']).toBeDefined()
  })

  it('rejects page-only libraries mounted directly as Worker plugins', () => {
    expect(() => packVfsImage({
      config: '- name: "@deepseek-ai/dsh-client-store"\n', profile: 'invalid-worker-page-entry',
      workspaces, resolveFrom: root, entries: [], pageOnlyPackages,
    })).toThrow(/composition names page-only package/)
  })

  it('rejects a Host module that actually imports a page-only library', () => {
    expect(() => packHost('import "@deepseek-ai/dsh-client-store"\nexport const hostReady = true\n'))
      .toThrow(/page-only package.*@deepseek-ai\/dsh-client-store/)
  })

  it('packs the shipped web profile with the authoritative static build roster', () => {
    const pagePackages = staticPagePackages(root)
    for (const name of pageOnlyPackages) expect(pagePackages.has(name)).toBe(true)
    expect(pagePackages.has('@deepseek-ai/cordis')).toBe(false)
    const result = packVfsImage({
      config: composeProfile(root, 'web'), profile: 'web', workspaces, resolveFrom: root,
      configTrees: configTrees(root), pageOnlyPackages: pagePackages,
    })
    expect(result.missing).toEqual([])
    for (const name of pagePackages) expect(result.packages.has(name)).toBe(false)
    expect(result.files['node_modules/@deepseek-ai/cordis/lib/index.js']).toBeDefined()
    expect(result.files['node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js']).toBeDefined()
  })

  it('packs the real Mesh module while UDP socket creation remains explicitly unavailable', () => {
    const result = packVfsImage({
      config: '- name: "@deepseek-ai/dsh-development-mesh-websocket"\n', profile: 'preview-mesh',
      workspaces, resolveFrom: root, entries: [],
    })
    expect(result.missing).toEqual([])
    expect(result.files['node_modules/@deepseek-ai/dsh-development-mesh-websocket/lib/index.js']).toBeDefined()
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
    const loaded: unknown = loader.createRequire('/dsh/')('node:dgram')
    if (typeof loaded !== 'object' || loaded === null || !('createSocket' in loaded)
      || typeof loaded.createSocket !== 'function') throw new Error('the UDP module must expose its refusing socket API')
    const createSocket = loaded.createSocket as typeof import('node:dgram').createSocket
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => createSocket('udp4')).toThrow(/node:dgram.createSocket is not available/)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('node:dgram.createSocket is not available'))
  })
})
