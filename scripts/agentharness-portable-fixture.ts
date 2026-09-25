/** Package the real cluster helper and its dependencies for isolated command tests. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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
}
