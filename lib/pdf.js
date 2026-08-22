import fs from 'node:fs/promises'
import path from 'node:path'

const PDF_SIGNATURE = Buffer.from('%PDF-')
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.avif', 'image/avif'],
])

export function extractGeminiFilePaths(text) {
  if (typeof text !== 'string') return []
  return [...text.matchAll(/\[\[dsh-gemini-file:([^\]\r\n]+)\]\]/g)].map((match) => path.resolve(match[1])).filter((value, index, all) => all.indexOf(value) === index)
}

export function extractPdfPath(text) {
  if (typeof text !== 'string') return null
  const candidates = []
  const quoted = /["']([^"']+?\.pdf)(?:["'])/gi
  for (const match of text.matchAll(quoted)) candidates.push(match[1])
  const bare = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>|*?"']+?\.pdf\b/gi
  for (const match of text.matchAll(bare)) candidates.push(match[0])
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (resolved.toLowerCase().endsWith('.pdf')) return resolved
  }
  return null
}

export function estimatePdfPages(bytes) {
  const sample = bytes.toString('latin1')
  const matches = sample.match(/\/Type\s*\/Page(?:\s|\/|>)/g)
  return matches?.length ?? null
}

export async function readPdfPart(filePath, options = {}) {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024
  const maxPages = options.maxPages ?? 300
  const absolute = path.resolve(filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error(`PDF path is not a file: ${absolute}`)
  if (stat.size > maxBytes) throw new Error(`PDF is too large (${stat.size} bytes; limit ${maxBytes})`)
  const data = await fs.readFile(absolute)
  if (!data.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new Error(`File is not a PDF: ${absolute}`)
  }
  const pages = estimatePdfPages(data)
  if (pages !== null && pages > maxPages) {
    throw new Error(`PDF has too many pages (${pages}; limit ${maxPages})`)
  }
  return {
    mimeType: 'application/pdf',
    data: data.toString('base64'),
    bytes: data.byteLength,
    pages,
    path: absolute,
    mtimeMs: stat.mtimeMs,
  }
}

export async function readMediaPart(filePath, options = {}) {
  const absolute = path.resolve(filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error(`Media path is not a file: ${absolute}`)
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  if (stat.size > maxBytes) throw new Error(`Media file is too large (${stat.size} bytes; limit ${maxBytes})`)
  const data = await fs.readFile(absolute)
  const ext = path.extname(absolute).toLowerCase()
  if (ext === '.pdf') return readPdfPart(absolute, options)
  const mimeType = IMAGE_TYPES.get(ext)
  if (!mimeType) throw new Error(`Unsupported Gemini media type: ${absolute}`)
  return { mimeType, data: data.toString('base64'), bytes: data.byteLength, path: absolute, mtimeMs: stat.mtimeMs }
}

export class PdfCache {
  constructor(options = {}) {
    this.maxBytes = options.maxCacheBytes ?? 64 * 1024 * 1024
    this.maxPdfBytes = options.maxBytes ?? 20 * 1024 * 1024
    this.maxPages = options.maxPages ?? 300
    this.entries = new Map()
    this.bytes = 0
  }

  async get(filePath) {
    const absolute = path.resolve(filePath)
    const stat = await fs.stat(absolute)
    const cached = this.entries.get(absolute)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.fileBytes === stat.size) {
      this.entries.delete(absolute)
      this.entries.set(absolute, cached)
      return cached.part
    }
    const part = await readPdfPart(absolute, { maxBytes: this.maxPdfBytes, maxPages: this.maxPages })
    const entry = { mtimeMs: part.mtimeMs, fileBytes: part.bytes, part }
    this.entries.delete(absolute)
    this.entries.set(absolute, entry)
    this.bytes += part.bytes
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const [oldestPath, oldest] = this.entries.entries().next().value
      this.entries.delete(oldestPath)
      this.bytes -= oldest.part.bytes
    }
    return part
  }
}

export class MediaCache extends PdfCache {
  constructor(options = {}) {
    super({ ...options, maxBytes: options.maxMediaBytes ?? options.maxBytes ?? 32 * 1024 * 1024 })
  }

  async get(filePath) {
    const absolute = path.resolve(filePath)
    const stat = await fs.stat(absolute)
    const cached = this.entries.get(absolute)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.fileBytes === stat.size) return cached.part
    const part = await readMediaPart(absolute, { maxBytes: this.maxPdfBytes, maxPages: this.maxPages })
    const old = this.entries.get(absolute)
    if (old) this.bytes -= old.part.bytes
    this.entries.delete(absolute)
    this.entries.set(absolute, { mtimeMs: part.mtimeMs, fileBytes: part.bytes, part })
    this.bytes += part.bytes
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const [oldestPath, oldest] = this.entries.entries().next().value
      this.entries.delete(oldestPath)
      this.bytes -= oldest.part.bytes
    }
    return part
  }
}
