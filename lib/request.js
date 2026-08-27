import { extractGeminiFilePaths, extractPdfPath } from './pdf.js'

function textOf(blocks) {
  return blocks.filter((block) => block.type === 'text' || block.type === 'reasoning').map((block) => block.text).join('')
}

function roleOf(role) {
  return role === 'assistant' ? 'model' : 'user'
}

function jsonArgs(raw) {
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

const TOOL_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

function schemaTypeFromValue(value) {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return undefined
}

export function sanitizeToolSchema(schema, fallbackType = 'object') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: fallbackType }
  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants)) {
    const concrete = variants.find((variant) => variant && typeof variant === 'object' && variant.type !== 'null')
    if (concrete) return sanitizeToolSchema(concrete, fallbackType)
  }

  let schemaType = schema.type
  if (Array.isArray(schemaType)) schemaType = schemaType.find((type) => type !== 'null' && TOOL_SCHEMA_TYPES.has(type))
  if (!TOOL_SCHEMA_TYPES.has(schemaType)) {
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) schemaType = 'object'
    else if (schema.items && typeof schema.items === 'object') schemaType = 'array'
    else schemaType = schemaTypeFromValue(schema.const)
      ?? schemaTypeFromValue(schema.default)
      ?? schemaTypeFromValue(schema.enum?.find((value) => value !== null))
      ?? fallbackType
  }

  const normalized = { type: schemaType }
  if (typeof schema.description === 'string' && schema.description) normalized.description = schema.description
  if (Array.isArray(schema.enum)) normalized.enum = schema.enum.filter((value) => value !== null)
  if (schemaType === 'object') {
    const properties = {}
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        properties[name] = sanitizeToolSchema(property, 'object')
      }
    }
    normalized.properties = properties
    if (Array.isArray(schema.required)) normalized.required = schema.required.filter((name) => typeof name === 'string' && name in properties)
    if (Array.isArray(schema.propertyOrdering)) normalized.propertyOrdering = schema.propertyOrdering.filter((name) => typeof name === 'string' && name in properties)
  } else if (schemaType === 'array') {
    normalized.items = sanitizeToolSchema(schema.items, 'object')
  }
  return normalized
}

export async function buildGeminiRequest(options, deps) {
  const pdfCache = deps.pdfCache
  const mediaCache = deps.mediaCache ?? pdfCache
  const attachments = deps.attachments
  const pdfConfig = deps.pdfConfig ?? {}
  const contents = []
  const callNames = new Map()
  let latestUserIndex = -1
  for (let i = options.messages.length - 1; i >= 0; i -= 1) {
    if (options.messages[i].role === 'user') { latestUserIndex = i; break }
  }

  for (let index = 0; index < options.messages.length; index += 1) {
    const message = options.messages[index]
    const parts = []
    for (const block of message.content ?? []) {
      if (block.type === 'text') {
        parts.push({ text: block.text })
      } else if (block.type === 'reasoning') {
        // Hidden reasoning is useful to the current UI stream, but replaying
        // every prior thought back to Gemini makes long tool turns grow
        // quadratically and can cause old planning text to reappear in the
        // final answer. Thought signatures on function calls are the provider
        // state that must be preserved; the private prose itself is not.
        if (message.role !== 'assistant') parts.push({ text: block.text })
      } else if (block.type === 'image') {
        if (!attachments) throw new Error('Gemini native provider requires the dsh attachment service for images')
        const image = await attachments.readImageRequest(block.attachment, {
          maxPixels: deps.imageMaxPixels ?? 2048 * 2048,
          maxBytes: deps.imageMaxBytes ?? 4 * 1024 * 1024,
        }, options.signal)
        parts.push({ inlineData: { mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64') } })
      } else if (block.type === 'tool-call') {
        callNames.set(block.id, block.name)
        const functionCallPart = { functionCall: { name: block.name, args: jsonArgs(block.arguments), id: block.id } }
        const signature = deps.callSignatures?.get(block.id)
        if (signature) functionCallPart.thoughtSignature = signature
        parts.push(functionCallPart)
      } else if (block.type === 'tool-result') {
        const name = callNames.get(block.toolCallId) ?? 'tool'
        parts.push({ functionResponse: { name, response: { result: textOf(block.content) }, id: block.toolCallId } })
      }
    }

    if (index === latestUserIndex) {
      const messageText = textOf(message.content ?? [])
      const uploaded = extractGeminiFilePaths(messageText)
      for (const mediaPath of uploaded) {
        const media = await mediaCache.get(mediaPath, { signal: options.signal })
        parts.push({ inlineData: { mimeType: media.mimeType, data: media.data } })
        parts.push({ text: `[已附加原始文件：${mediaPath}；${media.bytes} 字节]` })
      }
      if (pdfConfig.enabled && uploaded.length === 0) {
        const pdfPath = extractPdfPath(messageText)
        if (pdfPath) {
          const pdf = await pdfCache.get(pdfPath, { signal: options.signal })
          parts.push({ inlineData: { mimeType: pdf.mimeType, data: pdf.data } })
          parts.push({ text: `[已附加 PDF：${pdfPath}；约 ${pdf.bytes} 字节${pdf.pages ? `，${pdf.pages} 页` : ''}]` })
        }
      }
    }
    if (parts.length > 0) contents.push({ role: roleOf(message.role), parts })
  }

  const tools = []
  // Avoid Gemini 3's unstable built-in+function combination until the proxy
  // can encode include_server_side_tool_invocations reliably. Explicit dsh
  // function tools remain usable; search is still enabled for plain prompts.
  if (deps.googleSearch && !options.tools?.length) tools.push({ googleSearch: {} })
  if (options.tools?.length) {
    tools.push({ functionDeclarations: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeToolSchema(tool.parameters),
    })) })
  }
  const generationConfig = {}
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
  if (options.stop?.length) generationConfig.stopSequences = options.stop
  if (options.reasoningEffort) {
    const level = String(options.reasoningEffort).toUpperCase()
    if (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) {
      generationConfig.thinkingConfig = { thinkingLevel: level }
    }
  }
  const body = { contents }
  if (options.system) body.systemInstruction = { role: 'user', parts: [{ text: options.system }] }
  if (tools.length) body.tools = tools
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
  return body
}

export async function buildOpenAIRequest(options, deps) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages ?? []) {
    const textParts = []
    const contentParts = []
    const toolCalls = []
    let hasToolResults = false
    for (const block of message.content ?? []) {
      if (block.type === 'text') textParts.push(block.text)
      else if (block.type === 'reasoning') {
        if (message.role !== 'assistant') textParts.push(block.text)
      }
      else if (block.type === 'image') {
        if (!deps.attachments) throw new Error('Gemini OpenAI compatibility route requires the dsh attachment service for images')
        const image = await deps.attachments.readImageRequest(block.attachment, { maxPixels: deps.imageMaxPixels ?? 2048 * 2048, maxBytes: deps.imageMaxBytes ?? 4 * 1024 * 1024 }, options.signal)
        contentParts.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` } })
      } else if (block.type === 'tool-call') {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments || '{}' } })
      } else if (block.type === 'tool-result') {
        hasToolResults = true
        messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: textOf(block.content) })
      }
    }
    if (message.role === 'assistant' && (toolCalls.length || textParts.length)) {
      const assistant = { role: 'assistant', content: textParts.join('') || null }
      if (toolCalls.length) assistant.tool_calls = toolCalls
      messages.push(assistant)
    }
    else if (message.role !== 'tool' && (textParts.length || contentParts.length)) messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: contentParts.length ? [...(textParts.length ? [{ type: 'text', text: textParts.join('') }] : []), ...contentParts] : textParts.join('') })
  }
  const tools = options.tools?.length ? options.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: sanitizeToolSchema(tool.parameters) } })) : undefined
  const body = { model: options.model, messages, stream: true, stream_options: { include_usage: true } }
  if (tools) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop?.length) body.stop = options.stop
  if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort
  return body
}
