/** Package production helpers and dependencies for isolated portable command tests. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'tsdown'

/**
 * Copy production sources into a portable fixture without requiring a repository build.
 * @param destination - private fixture runtime directory.
 */
export async function copyClusterRuntime(destination: string): Promise<void> {
  await cp(join(import.meta.dirname, 'agentharness-cluster.mjs'), join(destination, 'agentharness-cluster.mjs'))
  const modules = join(destination, 'node_modules')
  await mkdir(modules, { recursive: true })
  await cp(dirname(fileURLToPath(import.meta.resolve('yaml/package.json'))), join(modules, 'yaml'), { recursive: true })
  const atomic = join(modules, '@deepseek-ai', 'dsh-atomic-write')
  await mkdir(atomic, { recursive: true })
  await writeFile(join(atomic, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  const source = await readFile(join(import.meta.dirname, '../packages/util/atomic-write/src/index.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
  await writeFile(join(atomic, 'index.js'), compiled.outputText)
  await bundleRuntimePackage(join(modules, '@deepseek-ai', 'dsh-credentials-local'),
    '../packages/credentials/credentials-local/src/index.ts')
}

/** Copy installed-command dependencies, including the mandatory MCP setup helper.
 * @param destination - private fixture runtime directory.
 */
export async function copyPortableCommandRuntime(destination: string): Promise<void> {
  await copyClusterRuntime(destination)
  await bundleRuntimePackage(join(destination, 'node_modules', '@deepseek-ai', 'dsh-host-mcp-client-setup'),
    '../packages/host/mcp-client-setup/src/index.ts')
}

async function bundleRuntimePackage(destination: string, entry: string): Promise<void> {
  await build({
    config: false,
    entry: { index: join(import.meta.dirname, entry) },
    outDir: destination,
    tsconfig: join(import.meta.dirname, '../tsconfig.base.json'),
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    plugins: [{
      name: 'portable-fixture-typescript',
      transform(source, id) {
        if (!id.endsWith('.ts')) return null
        return ts.transpileModule(source, { fileName: id,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
      },
    }],
    logLevel: 'silent',
  })
  await writeFile(join(destination, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
}
