import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { persistUpload } from '../lib/index.js'

function uploadRequest(bytes, { name = 'report.pdf', type = 'application/pdf', declaredBytes } = {}) {
  const request = Readable.from([bytes.subarray(0, Math.ceil(bytes.length / 2)), bytes.subarray(Math.ceil(bytes.length / 2))])
  request.headers = {
    'content-type': type,
    'x-file-name': encodeURIComponent(name),
    ...(declaredBytes === undefined ? {} : { 'content-length': String(declaredBytes) }),
  }
  return request
}

test('streams a binary PDF upload to a private temporary file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-upload-'))
  const source = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024, 7)])
  const file = await persistUpload(uploadRequest(source), { root, maxBytes: 3 * 1024 * 1024 })
  assert.equal(file.name, 'report.pdf')
  assert.equal(file.mimeType, 'application/pdf')
  assert.equal(file.bytes, source.length)
  assert.deepEqual(await fs.readFile(file.path), source)
  assert.match(file.marker, /^\[\[dsh-gemini-file:.+\]\]$/)
})

test('rejects oversized uploads before writing and removes partial files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-upload-'))
  await assert.rejects(
    persistUpload(uploadRequest(Buffer.alloc(32), { declaredBytes: 32 }), { root, maxBytes: 16 }),
    (error) => error.statusCode === 413,
  )
  assert.deepEqual(await fs.readdir(root).catch(() => []), [])

  await assert.rejects(
    persistUpload(uploadRequest(Buffer.alloc(32)), { root, maxBytes: 16 }),
    (error) => error.statusCode === 413,
  )
  assert.deepEqual(await fs.readdir(root), [])
})
