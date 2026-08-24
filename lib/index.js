import { MediaCache } from './pdf.js'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { buildGeminiRequest, buildOpenAIRequest } from './request.js'
import { extractGeminiFilePaths, extractPdfPath } from './pdf.js'

const PACKAGE = 'dsh-gemini-aistudio'
const DEFAULT_REASONING_EFFORT = 'high'
const REASONING_EFFORT_NAMES = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const name = PACKAGE
export const inject = ['llm', 'webServer']

export function reasoningMetadata(entry = {}) {
  if (entry.reasoning === false) return undefined
  const ids = entry.reasoningEfforts ?? entry.reasoning_efforts ?? Object.keys(REASONING_EFFORT_NAMES)
  const efforts = ids
    .filter((id) => REASONING_EFFORT_NAMES[id])
    .map((id) => ({ id, name: REASONING_EFFORT_NAMES[id] }))
  if (!efforts.length) return undefined
  const requestedDefault = entry.defaultReasoningEffort ?? entry.default_reasoning_effort ?? DEFAULT_REASONING_EFFORT
  const defaultEffort = efforts.some((effort) => effort.id === requestedDefault)
    ? requestedDefault
    : efforts[efforts.length - 1].id
  return { efforts, defaultEffort }
}

function configValue(config, key, fallback) {
  return config?.[key] === undefined ? fallback : config[key]
}

function usableApiKey(raw, ref) {
  const value = String(raw ?? '').trim()
  if (!value || !/^[\x21-\x7E]+$/.test(value)) throw new Error(`${PACKAGE}: missing or invalid credential ${ref}`)
  return value
}

function optionalApiKey(raw) {
  const value = String(raw ?? '').trim()
  return value && /^[\x21-\x7E]+$/.test(value) ? value : undefined
}

function finish(kind = 'stop') {
  return { type: 'finish', reason: { kind } }
}

function responseFailure(message, status) {
  const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR'
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function normalizeToolArguments(name, rawArguments) {
  let args
  if (typeof rawArguments === 'string') {
    try { args = JSON.parse(rawArguments || '{}') } catch { return rawArguments }
  } else {
    args = rawArguments
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return rawArguments

  if (name === 'pwsh') {
    if (typeof args.command !== 'string' || !args.command.trim() || typeof args.description === 'string' && args.description.trim()) {
      return rawArguments
    }
    const repaired = { ...args, description: 'Run PowerShell command' }
    return typeof rawArguments === 'string' ? JSON.stringify(repaired) : repaired
  }

  if ((name === 'write' || name === 'edit') && args.justification !== undefined && args.sandbox_permissions === undefined) {
    const repaired = { ...args }
    delete repaired.justification
    return typeof rawArguments === 'string' ? JSON.stringify(repaired) : repaired
  }

  if (name === 'todo_write' && Array.isArray(args.todos) && args.todos.some((todo) => todo === null)) {
    const repaired = { ...args, todos: args.todos.filter((todo) => todo && typeof todo === 'object' && !Array.isArray(todo)) }
    return typeof rawArguments === 'string' ? JSON.stringify(repaired) : repaired
  }

  return rawArguments
}

export function shouldUseOpenAICompatibility(options = {}) {
  const latestUser = [...(options.messages ?? [])].reverse().find((message) => message.role === 'user')
  const latestText = latestUser?.content?.filter((block) => block.type === 'text' || block.type === 'reasoning').map((block) => block.text).join('') ?? ''
  const hasFile = latestUser?.content?.some((block) => block.type === 'image') || extractGeminiFilePaths(latestText).length > 0 || Boolean(extractPdfPath(latestText))
  return Boolean(options.tools?.length) && !hasFile
}

class GeminiAdapter {
  constructor(config) {
    this.config = config
    this.provider = config.provider
    this.baseURL = String(config.baseURL).replace(/\/$/, '')
    this.mediaCache = new MediaCache(config.pdf)
    this.callSignatures = new Map()
    this.modelCache = { expiresAt: 0, models: [] }
    this.modelFetch = null
  }

  providerInfo(provider) { return { id: provider, name: 'Google AI Studio (native)' } }

  providerRetryPolicy() { return undefined }

  async fetchModels() {
    const now = Date.now()
    if (this.modelCache.expiresAt > now && this.modelCache.models.length) return this.modelCache.models
    if (this.modelFetch) return this.modelFetch
    this.modelFetch = this.fetchModelsUncached(now)
    try {
      return await this.modelFetch
    } finally {
      this.modelFetch = null
    }
  }

  async fetchModelsUncached(now) {
    const key = await this.config.resolveApiKey?.(true)
    if (key) try {
      const response = await fetch(`${this.baseURL}/v1/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`)
      const payload = await response.json()
      const discovered = (payload.data ?? [])
        .filter((entry) => String(entry.id ?? '').toLowerCase().startsWith('gemini-'))
        .map((entry) => ({
          provider: this.provider,
          id: String(entry.id),
          name: entry.name ?? String(entry.id),
          inputModalities: entry.inputModalities ?? entry.input_modalities ?? ['text', 'image'],
          reasoning: reasoningMetadata(entry),
          context: { contextWindow: entry.contextWindow ?? entry.context_window ?? 1_000_000 },
          defaultMaxTokens: entry.maxTokens ?? entry.max_output_tokens ?? 65_536,
        }))
      if (discovered.length) {
        this.modelCache = { expiresAt: now + 5 * 60 * 1000, models: discovered }
        return discovered
      }
    } catch (error) {
      console.warn(`${PACKAGE}: model discovery unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const fallback = (this.config.models ?? []).filter((id) => String(id).toLowerCase().startsWith('gemini-')).map((id) => ({
      provider: this.provider,
      id,
      name: id,
      inputModalities: ['text', 'image'],
      reasoning: reasoningMetadata(),
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 65_536,
    }))
    this.modelCache = { expiresAt: now + 30 * 1000, models: fallback }
    return fallback
  }

  async listModels(provider) {
    return (await this.fetchModels()).map((model) => ({ ...model, provider }))
  }

  async resolveModel(provider, model) {
    const models = await this.fetchModels()
    const found = models.find((entry) => entry.id === model)
    if (!found && this.config.models?.length && !this.config.models.includes(model)) throw new Error(`Unknown Gemini model: ${model}`)
    return { ...(found ?? {
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      reasoning: reasoningMetadata(),
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 65_536,
    }), provider }
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    const keyName = configValue(this.config, 'apiKeyEnv', 'AISTUDIO_API_KEY')
    const key = usableApiKey(await this.config.resolveApiKey?.(false), keyName)
    const openAICompatibility = shouldUseOpenAICompatibility(options)
    const attachments = this.config.resolveAttachments?.()
    const body = await (openAICompatibility ? buildOpenAIRequest : buildGeminiRequest)(options, {
      attachments,
      pdfCache: this.mediaCache,
      mediaCache: this.mediaCache,
      callSignatures: this.callSignatures,
      pdfConfig: this.config.pdf,
      googleSearch: this.config.googleSearch,
      imageMaxPixels: this.config.imageMaxPixels,
      imageMaxBytes: this.config.imageMaxBytes,
    })
    const url = openAICompatibility
      ? `${this.baseURL}/v1/chat/completions`
      : `${this.baseURL}/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    if (!response.ok) throw responseFailure(`AI Studio proxy returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`, response.status)
    if (!response.body) throw new Error('AI Studio proxy returned no response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let toolIndex = 0
    const openAIToolCalls = new Map()
    let usage
    const emitEvent = async function* (event) {
      const candidates = event?.candidates ?? []
      for (const candidate of candidates) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            yield { type: part.thought ? 'reasoning-delta' : 'text-delta', index: part.thought ? 1 : 0, text: part.text }
          }
          if (part.functionCall) {
            const call = part.functionCall
            if (call.thoughtSignature) this.callSignatures.set(call.id ?? `gemini-call-${toolIndex}`, call.thoughtSignature)
            const index = toolIndex++
            const id = call.id ?? `gemini-call-${index}`
            const args = normalizeToolArguments(call.name, JSON.stringify(call.args ?? {}))
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
          }
        }
      }
      if (event?.usageMetadata) usage = event.usageMetadata
    }
    const parseNative = async function* (line) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const raw = trimmed.slice(5).trim()
      if (!raw || raw === '[DONE]') return
      try { yield* emitEvent(JSON.parse(raw)) } catch { /* ignore keep-alive/non-json lines */ }
    }
    const parseOpenAI = async function* (line) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const raw = trimmed.slice(5).trim()
      if (!raw || raw === '[DONE]') return
      let event
      try { event = JSON.parse(raw) } catch { return }
      const choice = event.choices?.[0]
      const delta = choice?.delta ?? {}
      if (delta.content) yield { type: 'text-delta', index: 0, text: delta.content }
      const reasoning = delta.reasoning_content ?? delta.thinking
      if (reasoning) yield { type: 'reasoning-delta', index: 1, text: reasoning }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0
        let current = openAIToolCalls.get(index)
        if (!current) {
          current = { id: call.id ?? `gemini-call-${index}`, name: call.function?.name ?? '', arguments: '' }
          openAIToolCalls.set(index, current)
          yield { type: 'block-start', index, blockType: 'tool-call' }
        }
        if (call.id) current.id = call.id
        if (call.function?.name) current.name = call.function.name
        const deltaArgs = call.function?.arguments ?? ''
        current.arguments += deltaArgs
        yield { type: 'tool-call-delta', index, id: current.id, name: current.name || undefined, argumentsDelta: deltaArgs }
      }
      if (event.usage) usage = event.usage
    }
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* (openAICompatibility ? parseOpenAI(line) : parseNative(line))
      if (done) break
    }
    for (const [index, call] of openAIToolCalls) {
      yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: normalizeToolArguments(call.name, call.arguments) } }
    }
    if (usage) yield { type: 'usage', usage: { inputTokens: usage.promptTokenCount ?? usage.prompt_tokens ?? 0, outputTokens: usage.candidatesTokenCount ?? usage.completion_tokens ?? 0, reasoningTokens: usage.thoughtsTokenCount ?? usage.completion_tokens_details?.reasoning_tokens } }
    yield finish(toolIndex || openAIToolCalls.size ? 'tool-calls' : 'stop')
  }
}

export function apply(ctx, config = {}) {
  const llm = ctx.llm
  const effective = {
    provider: configValue(config, 'provider', 'aistudio-gemini'),
    baseURL: configValue(config, 'baseURL', 'http://127.0.0.1:8080'),
    apiKeyEnv: configValue(config, 'apiKeyEnv', 'AISTUDIO_API_KEY'),
    googleSearch: configValue(config, 'googleSearch', true),
    models: configValue(config, 'models', ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview']),
    pdf: configValue(config, 'pdf', { enabled: true, maxBytes: 20 * 1024 * 1024, maxPages: 300 }),
  }
  const credentialNames = [...new Set([
    effective.apiKeyEnv,
    'GEMINI_AISTUDIO_API_KEY',
    'AISTUDIO_API_KEY',
  ].map((value) => String(value ?? '').trim()).filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))]
  effective.resolveApiKey = async (optional = false) => {
    const credentials = ctx.get?.('credentials')
    for (const ref of credentialNames) {
      const stored = optionalApiKey((await credentials?.resolve?.(ref))?.value)
      if (stored) return stored
      const ambient = optionalApiKey(process.env[ref])
      if (ambient) return ambient
    }
    if (optional) return undefined
    throw new Error(`${PACKAGE}: no API key is configured; store ${effective.apiKeyEnv} on dsh's Models page or export it before starting dsh`)
  }
  effective.resolveAttachments = () => ctx.get?.('attachments')
  const adapter = new GeminiAdapter(effective)
  ctx.effect(
    () => registerUploadEndpoint(ctx, { maxBytes: effective.pdf.maxBytes, ...(config.upload ?? {}) }),
    `${PACKAGE}: upload endpoint`,
  )
  return llm.registerAdapter([effective.provider], adapter)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

const UPLOAD_MIME_BY_EXT = new Map([
  ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.avif', 'image/avif'],
])
const UPLOAD_EXT_BY_MIME = new Map([
  ['application/pdf', '.pdf'], ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'],
  ['image/gif', '.gif'], ['image/avif', '.avif'],
])

function uploadError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function requestHeader(req, name) {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function uploadMetadata(req) {
  const encodedName = String(requestHeader(req, 'x-file-name') ?? 'upload')
  let decodedName
  try { decodedName = decodeURIComponent(encodedName) } catch { decodedName = encodedName }
  const name = path.basename(decodedName) || 'upload'
  const requestedType = String(requestHeader(req, 'content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  const requestedExt = path.extname(name).toLowerCase()
  const mimeType = UPLOAD_MIME_BY_EXT.get(requestedExt) ?? (UPLOAD_EXT_BY_MIME.has(requestedType) ? requestedType : null)
  if (!mimeType) throw uploadError('只支持 PNG、JPEG、WebP、GIF、AVIF 和 PDF', 415)
  const safeExt = UPLOAD_MIME_BY_EXT.has(requestedExt) ? requestedExt : UPLOAD_EXT_BY_MIME.get(mimeType)
  return { name, mimeType, safeExt }
}

export async function persistUpload(req, options = {}) {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  const root = options.root ?? path.join(os.tmpdir(), PACKAGE)
  const declaredBytes = Number(requestHeader(req, 'content-length'))
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw uploadError(`文件超过 ${maxBytes} 字节限制`, 413)
  }
  const { name, mimeType, safeExt } = uploadMetadata(req)
  await fs.mkdir(root, { recursive: true })
  const filePath = path.join(root, `${crypto.randomUUID()}${safeExt}`)
  const partialPath = `${filePath}.part`
  let bytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > maxBytes ? uploadError(`文件超过 ${maxBytes} 字节限制`, 413) : null, chunk)
    },
  })
  try {
    await pipeline(req, limiter, createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }))
    if (!bytes) throw uploadError('文件为空', 400)
    await fs.rename(partialPath, filePath)
  } catch (error) {
    await fs.unlink(partialPath).catch(() => {})
    throw error
  }
  return { name, mimeType, bytes, path: filePath, marker: `[[dsh-gemini-file:${filePath}]]` }
}

async function cleanupStaleUploads(root, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(root, entry.name)
    const stat = await fs.stat(filePath).catch(() => null)
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(filePath).catch(() => {})
  }))
}

function registerUploadEndpoint(ctx, config) {
  const maxBytes = config.maxBytes ?? 32 * 1024 * 1024
  const root = path.join(os.tmpdir(), PACKAGE)
  const retentionMs = config.retentionMs ?? 24 * 60 * 60 * 1000
  let nextCleanupAt = 0
  const handler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' })
    try {
      if (Date.now() >= nextCleanupAt) {
        nextCleanupAt = Date.now() + 60 * 60 * 1000
        await cleanupStaleUploads(root, retentionMs)
      }
      return sendJson(res, 200, { ok: true, file: await persistUpload(req, { maxBytes, root }) })
    } catch (error) {
      return sendJson(res, error?.statusCode ?? 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: `/${PACKAGE}/api`, handler })
}

export { GeminiAdapter }
