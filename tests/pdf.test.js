import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractGeminiFilePaths, extractPdfPath, estimatePdfPages, readPdfPart, PdfCache, readMediaPart } from '../lib/pdf.js'

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

test('counts page objects without copying the whole PDF to a string', () => {
  const bytes = Buffer.from('%PDF-1.7\n/Type /Pages\n/Type\t/Page\n/Type/Page>\n')
  assert.equal(estimatePdfPages(bytes), 2)
})

test('cache accounts for encoded memory and drops stale or oversized entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-'))
  const file = path.join(dir, 'cache.pdf')
  await fs.writeFile(file, Buffer.from('%PDF-1.7\n/Type /Page\nfirst'))
  const cache = new PdfCache({ maxCacheBytes: 128, maxCacheEntryBytes: 64 })
  await cache.get(file)
  assert.equal(cache.entries.size, 1)
  assert.equal(cache.bytes, Buffer.byteLength(cache.entries.get(path.resolve(file)).part.data))

  await new Promise((resolve) => setTimeout(resolve, 10))
  await fs.writeFile(file, Buffer.from('%PDF-1.7\n/Type /Page\nsecond-version'))
  await cache.get(file)
  assert.equal(cache.entries.size, 1)
  assert.equal(cache.bytes, Buffer.byteLength(cache.entries.get(path.resolve(file)).part.data))

  const large = path.join(dir, 'large-cache.pdf')
  await fs.writeFile(large, Buffer.concat([Buffer.from('%PDF-1.7\n/Type /Page\n'), Buffer.alloc(80)]))
  await cache.get(large)
  assert.equal(cache.entries.has(path.resolve(large)), false)
  assert.ok(cache.bytes <= cache.maxBytes)
})
