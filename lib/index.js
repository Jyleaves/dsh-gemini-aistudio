import { MediaCache } from './pdf.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildGeminiRequest, buildOpenAIRequest } from './request.js'
import { extractGeminiFilePaths, extractPdfPath } from './pdf.js'

const PACKAGE = 'dsh-gemini-aistudio'

export const name = PACKAGE
export const inject = ['llm', 'webServer']

function configValue(config, key, fallback) {
  return config?.[key] === undefined ? fallback : config[key]
}

function usableApiKey(raw, ref) {
  const value = String(raw ?? '').trim()
  if (!value || !/^[\x21-\x7E]+$/.test(value)) throw new Error(`${PACKAGE}: missing or invalid credential ${ref}`)
  return value
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

  return rawArguments
}

class GeminiAdapter {
  constructor(config) {
    this.config = config
    this.provider = config.provider
    this.baseURL = String(config.baseURL).replace(/\/$/, '')
    this.mediaCache = new MediaCache(config.pdf)
    this.callSignatures = new Map()
    this.modelCache = { expiresAt: 0, models: [] }
  }

  providerInfo(provider) { return { id: provider, name: 'Google AI Studio (native)' } }

  providerRetryPolicy() { return undefined }

  async fetchModels() {
    const now = Date.now()
    if (this.modelCache.expiresAt > now && this.modelCache.models.length) return this.modelCache.models
    const keyName = configValue(this.config, 'apiKeyEnv', 'AISTUDIO_API_KEY')
    const key = usableApiKey(process.env[keyName], keyName)
    try {
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
          inputModalities: entry.inputModalities ?? ['text', 'image'],
          reasoning: entry.reasoning ?? true,
          context: { contextWindow: entry.contextWindow ?? 1_000_000 },
          defaultMaxTokens: entry.maxTokens ?? 65_536,
        }))
      if (discovered.length) {
        this.modelCache = { expiresAt: now + 5 * 60 * 1000, models: discovered }
        return discovered
      }
    } catch (error) {
      console.warn(`${PACKAGE}: model discovery unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return (this.config.models ?? []).filter((id) => String(id).toLowerCase().startsWith('gemini-')).map((id) => ({
      provider: this.provider,
      id,
      name: id,
      inputModalities: ['text', 'image'],
      reasoning: true,
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 65_536,
    }))
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
      reasoning: true,
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 65_536,
    }), provider }
  }

  async *stream(options) {
    const keyName = configValue(this.config, 'apiKeyEnv', 'AISTUDIO_API_KEY')
    const key = usableApiKey(process.env[keyName], keyName)
    const latestText = [...(options.messages ?? [])].reverse().find((message) => message.role === 'user')?.content?.filter((block) => block.type === 'text' || block.type === 'reasoning').map((block) => block.text).join('') ?? ''
    const hasFile = extractGeminiFilePaths(latestText).length > 0 || Boolean(extractPdfPath(latestText))
    const openAICompatibility = Boolean(options.tools?.length) && !hasFile
    const body = await (openAICompatibility ? buildOpenAIRequest : buildGeminiRequest)(options, {
      attachments: this.config.attachments,
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
      if (delta.thinking) yield { type: 'reasoning-delta', index: 1, text: delta.thinking }
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
    baseURL: configValue(config, 'baseURL', 'http://127.0.0.1:8090'),
    apiKeyEnv: configValue(config, 'apiKeyEnv', 'AISTUDIO_API_KEY'),
    googleSearch: configValue(config, 'googleSearch', true),
    models: configValue(config, 'models', ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview']),
    pdf: configValue(config, 'pdf', { enabled: true, maxBytes: 20 * 1024 * 1024, maxPages: 300 }),
  }
  const attachments = ctx.get?.('attachments')
  effective.attachments = attachments
  const adapter = new GeminiAdapter(effective)
  ctx.effect(() => registerUploadEndpoint(ctx, config.upload ?? {}), `${PACKAGE}: upload endpoint`)
  return llm.registerAdapter([effective.provider], adapter)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

function registerUploadEndpoint(ctx, config) {
  const maxBytes = config.maxBytes ?? 32 * 1024 * 1024
  const root = path.join(os.tmpdir(), PACKAGE)
  const handler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' })
    try {
      const body = JSON.parse(await readBody(req))
      const name = path.basename(String(body.name ?? 'upload'))
      const type = String(body.type ?? '').toLowerCase()
      const ext = path.extname(name).toLowerCase()
      const allowed = type.startsWith('image/') || type === 'application/pdf' || ext === '.pdf'
      if (!allowed) return sendJson(res, 415, { ok: false, error: '只支持图片和 PDF' })
      const bytes = Buffer.from(String(body.data ?? ''), 'base64')
      if (!bytes.length || bytes.length > maxBytes) return sendJson(res, 413, { ok: false, error: `文件超过 ${maxBytes} 字节限制` })
      await fs.mkdir(root, { recursive: true })
      const safeExt = ext || (type === 'application/pdf' ? '.pdf' : '.img')
      const filePath = path.join(root, `${crypto.randomUUID()}${safeExt}`)
      await fs.writeFile(filePath, bytes, { mode: 0o600 })
      const mimeType = type.startsWith('image/') ? type : 'application/pdf'
      return sendJson(res, 200, { ok: true, file: { name, mimeType, bytes: bytes.length, path: filePath, marker: `[[dsh-gemini-file:${filePath}]]` } })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: `/${PACKAGE}/api`, handler })
}

export { GeminiAdapter }
