import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewedFileEvidenceProvider } from '../src/index.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ReviewedFileEvidenceProvider', () => {
  it('loads a strict reviewed corpus and ranks multilingual terms', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-reviewed-evidence-'))
    const path = join(root, 'knowledge.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      items: [
        { id: 'frontend-debug', title: '前端调试手册', summary: '先确认 readiness，再读取浏览器错误。', source: 'wiki://frontend', revision: '3', tags: ['前端', 'debug'] },
        { id: 'backend-release', title: 'Backend release', summary: 'Run focused checks.', source: 'wiki://backend', revision: '2' },
      ],
    }))
    const provider = new ReviewedFileEvidenceProvider({ providerId: 'team-wiki', label: 'Team Wiki', path, maxFileBytes: 16_384 })

    await expect(provider.query({ query: '前端 readiness', limit: 5 }, new AbortController().signal))
      .resolves.toMatchObject({ status: 'available', items: [{ id: 'frontend-debug' }] })
    await expect(provider.query({ query: 'unrelated', limit: 5 }, new AbortController().signal))
      .resolves.toEqual({ status: 'empty' })
  })

  it('fails load for oversized or duplicate corpora', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-reviewed-evidence-'))
    const path = join(root, 'knowledge.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      items: [
        { id: 'same', title: 'A', summary: 'A', source: 'A', revision: '1' },
        { id: 'same', title: 'B', summary: 'B', source: 'B', revision: '1' },
      ],
    }))
    expect(() => new ReviewedFileEvidenceProvider({ providerId: 'wiki', label: 'Wiki', path, maxFileBytes: 10 }))
      .toThrow('exceeds maxFileBytes')
    expect(() => new ReviewedFileEvidenceProvider({ providerId: 'wiki', label: 'Wiki', path, maxFileBytes: 16_384 }))
      .toThrow('item ids must be unique')
  })
})
