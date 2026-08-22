import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractGeminiFilePaths, extractPdfPath, readPdfPart, PdfCache, readMediaPart } from '../lib/pdf.js'

test('detects Windows PDF paths and reads a small PDF', async () => {
  assert.equal(extractPdfPath('请读取 "C:\\docs\\report.pdf"'), path.resolve('C:\\docs\\report.pdf'))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-'))
  const file = path.join(dir, 'report.pdf')
  await fs.writeFile(file, Buffer.from('%PDF-1.7\n/Type /Page\n'))
  const part = await readPdfPart(file)
  assert.equal(part.mimeType, 'application/pdf')
  assert.equal(part.pages, 1)
  const cache = new PdfCache({ maxCacheBytes: 100 })
  assert.equal((await cache.get(file)).data, part.data)
})

test('rejects oversized PDFs before network upload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-'))
  const file = path.join(dir, 'large.pdf')
  await fs.writeFile(file, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]))
  await assert.rejects(readPdfPart(file, { maxBytes: 8 }), /too large/)
})

test('reads an original image and extracts the upload marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-'))
  const file = path.join(dir, 'photo.png')
  await fs.writeFile(file, Buffer.from([137, 80, 78, 71, 1, 2]))
  const part = await readMediaPart(file)
  assert.equal(part.mimeType, 'image/png')
  assert.deepEqual(extractGeminiFilePaths(`[[dsh-gemini-file:${file}]]`), [path.resolve(file)])
})
