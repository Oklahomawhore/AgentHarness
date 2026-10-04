import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkbench } from './workbench.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'scope-evaluation-files-'))
  roots.push(root)
  await fs.mkdir(join(root, 'role'))
  await fs.writeFile(join(root, 'role/client.mjs'), 'original')
  await fs.writeFile(join(root, 'private.txt'), 'private')
  const workbench = await createWorkbench({ root, readableFiles: ['role/client.mjs'],
    writableFiles: ['role/client.mjs', 'role/new.mjs'], maxReadBytes: 16, maxWriteBytes: 16 })
  return { root, workbench }
}

it('reads exact bytes and commits allowed replacement and new files', async () => {
  const { root, workbench } = await fixture()
  const signal = new AbortController().signal
  const content = '新字段'
  const written = await workbench.write('role/client.mjs', content, signal)
  expect(written).toEqual({ path: 'role/client.mjs', bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex') })
  expect(await workbench.read('role/client.mjs', signal)).toEqual({ ...written, text: content })
  await workbench.write('role/new.mjs', 'new', signal)
  expect(await fs.readFile(join(root, 'role/new.mjs'), 'utf8')).toBe('new')
  expect(await fs.readdir(join(root, 'role'))).toEqual(['client.mjs', 'new.mjs'])
})

it.each(['/outside.txt', '../private.txt', 'role/../private.txt', './role/client.mjs', 'role//client.mjs',
  'C:\\private.txt', 'role\\client.mjs'])('rejects noncanonical or absolute model paths: %s', async (path) => {
  const { workbench } = await fixture()
  const signal = new AbortController().signal
  await expect(workbench.read(path, signal)).rejects.toMatchObject({ code: 'invalid-path' })
  await expect(workbench.write(path, 'changed', signal)).rejects.toMatchObject({ code: 'invalid-path' })
})

it('keeps read and write permissions separate and leaves non-allowlisted artifacts unchanged', async () => {
  const { root, workbench } = await fixture()
  const signal = new AbortController().signal
  await expect(workbench.read('private.txt', signal)).rejects.toMatchObject({ code: 'not-allowed' })
  await expect(workbench.write('private.txt', 'changed', signal)).rejects.toMatchObject({ code: 'not-allowed' })
  await expect(workbench.read('role/new.mjs', signal)).rejects.toMatchObject({ code: 'not-allowed' })
  expect(await fs.readFile(join(root, 'private.txt'), 'utf8')).toBe('private')
})

it('rejects target and ancestor symlinks without reading or changing their destinations', async () => {
  const { root, workbench } = await fixture()
  const signal = new AbortController().signal
  await fs.rm(join(root, 'role/client.mjs'))
  await fs.symlink('../private.txt', join(root, 'role/client.mjs'))
  await expect(workbench.read('role/client.mjs', signal)).rejects.toMatchObject({ code: 'symlink' })
  await expect(workbench.write('role/client.mjs', 'changed', signal)).rejects.toMatchObject({ code: 'symlink' })
  await fs.rm(join(root, 'role'), { recursive: true })
  await fs.mkdir(join(root, 'other'))
  await fs.writeFile(join(root, 'other/client.mjs'), 'other role')
  await fs.symlink('other', join(root, 'role'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(workbench.read('role/client.mjs', signal)).rejects.toMatchObject({ code: 'symlink' })
  await expect(workbench.write('role/client.mjs', 'changed', signal)).rejects.toMatchObject({ code: 'symlink' })
  expect(await fs.readFile(join(root, 'other/client.mjs'), 'utf8')).toBe('other role')
  expect(await fs.readFile(join(root, 'private.txt'), 'utf8')).toBe('private')
})

it('counts complete UTF-8 bytes and rejects oversized reads or writes without truncation', async () => {
  const { root, workbench } = await fixture()
  const signal = new AbortController().signal
  await expect(workbench.write('role/client.mjs', '字'.repeat(6), signal)).rejects.toMatchObject({ code: 'byte-limit' })
  expect(await fs.readFile(join(root, 'role/client.mjs'), 'utf8')).toBe('original')
  await fs.writeFile(join(root, 'role/client.mjs'), '字'.repeat(6))
  await expect(workbench.read('role/client.mjs', signal)).rejects.toMatchObject({ code: 'byte-limit' })
})

it('cancels queued work without changing files and permits a later operation', async () => {
  const { root, workbench } = await fixture()
  const cancelled = new AbortController()
  cancelled.abort(new Error('cancelled fixture work'))
  await expect(workbench.write('role/client.mjs', 'changed', cancelled.signal)).rejects.toThrow('cancelled fixture work')
  await expect(workbench.read('role/client.mjs', cancelled.signal)).rejects.toThrow('cancelled fixture work')
  expect(await fs.readFile(join(root, 'role/client.mjs'), 'utf8')).toBe('original')
  expect((await workbench.read('role/client.mjs', new AbortController().signal)).text).toBe('original')
})

it('keeps the original visible until atomic commit and removes cancelled staged bytes', async () => {
  const { root, workbench } = await fixture()
  const staged = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const writeFile = fs.writeFile.bind(fs)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    await writeFile(...args)
    staged.resolve(undefined)
    await release.promise
  })
  const controller = new AbortController()
  const pending = workbench.write('role/client.mjs', 'replacement', controller.signal)
  const rejected = expect(pending).rejects.toThrow('cancelled before commit')
  try {
    await staged.promise
    expect(await fs.readFile(join(root, 'role/client.mjs'), 'utf8')).toBe('original')
    controller.abort(new Error('cancelled before commit'))
  } finally {
    controller.abort(new Error('cancelled before commit'))
    release.resolve(undefined)
    await rejected
  }
  expect(await fs.readFile(join(root, 'role/client.mjs'), 'utf8')).toBe('original')
  expect(await fs.readdir(join(root, 'role'))).toEqual(['client.mjs'])
})

it('rejects a replaced directory root instead of adopting a different workspace', async () => {
  const { root, workbench } = await fixture()
  const previous = `${root}-previous`
  roots.push(previous)
  await fs.rename(root, previous)
  await fs.mkdir(root)
  await expect(workbench.write('role/client.mjs', 'changed', new AbortController().signal))
    .rejects.toMatchObject({ code: 'invalid-root' })
  expect(await fs.readFile(join(previous, 'role/client.mjs'), 'utf8')).toBe('original')
})

it('removes its staged file after commit failure and preserves the previous complete file', async () => {
  const { root, workbench } = await fixture()
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('fixture commit failed'))
  await expect(workbench.write('role/client.mjs', 'replacement', new AbortController().signal))
    .rejects.toThrow('fixture commit failed')
  expect(await fs.readFile(join(root, 'role/client.mjs'), 'utf8')).toBe('original')
  expect(await fs.readdir(join(root, 'role'))).toEqual(['client.mjs'])
})

it('reports an already committed write when cancellation arrives during rename', async () => {
  const { root, workbench } = await fixture()
  const controller = new AbortController()
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args)
    controller.abort(new Error('too late to undo the committed file'))
  })
  expect(await workbench.write('role/client.mjs', 'replacement', controller.signal))
    .toMatchObject({ path: 'role/client.mjs', bytes: 11 })
  expect(await fs.readFile(join(root, 'role/client.mjs'), 'utf8')).toBe('replacement')
  expect(await fs.readdir(join(root, 'role'))).toEqual(['client.mjs'])
})
