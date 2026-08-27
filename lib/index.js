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
export const inject = ['llm', 'webServer', 'tools']

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

function finishFailure(message, code = 'PROVIDER_ERROR') {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

function finishKind(nativeReason, openAIReason, hasToolCalls) {
  if (hasToolCalls || openAIReason === 'tool_calls') return 'tool-calls'
  if (nativeReason === 'MAX_TOKENS' || openAIReason === 'length') return 'max-tokens'
  return 'stop'
}

function responseFailure(message, status) {
  const numericStatus = Number(status)
  const failureText = `${status ?? ''} ${message ?? ''}`
  const code = numericStatus === 401 || numericStatus === 403
    ? 'AUTH'
    : numericStatus === 429 || /(?:resource[_ -]?exhausted|rate[_ -]?limit|too many requests|quota|配额)/iu.test(failureText)
      ? 'RATE_LIMIT'
      : 'PROVIDER_ERROR'
  const error = new Error(message)
  error.code = code
  error.status = Number.isFinite(numericStatus) ? numericStatus : status
  return error
}

const OMIT_TOOL_ARGUMENT = Symbol('omit-tool-argument')

function schemaVariants(schema) {
  const variants = schema?.anyOf ?? schema?.oneOf
  if (!Array.isArray(variants)) return []
  // JSON Schema permits constraints such as minimum/maximum/description on
  // the parent alongside anyOf/oneOf type branches. Preserve those shared
  // constraints when validating or repairing a selected branch.
  const { anyOf: _anyOf, oneOf: _oneOf, ...shared } = schema
  return variants
    .filter((variant) => variant && typeof variant === 'object')
    .map((variant) => ({ ...shared, ...variant }))
}

function schemaTypes(schema) {
  const raw = schema?.type
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return [raw]
  if (schema?.properties && typeof schema.properties === 'object') return ['object']
  if (schema?.items && typeof schema.items === 'object') return ['array']
  return []
}

function schemaAcceptsValue(value, schema) {
  if (!schema || typeof schema !== 'object') return true
  const variants = schemaVariants(schema)
  if (variants.length) return variants.some((variant) => schemaAcceptsValue(value, variant))
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) return false
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false
  if (value === null) {
    return schema.nullable === true
      || schemaTypes(schema).includes('null')
      || Object.hasOwn(schema, 'const') && schema.const === null
      || Array.isArray(schema.enum) && schema.enum.includes(null)
  }
  const types = schemaTypes(schema)
  if (!types.length) return true
  return types.some((type) => {
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    if (type === 'integer' || type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      if (type === 'integer' && !Number.isInteger(value)) return false
      if (Number.isFinite(schema.minimum) && value < schema.minimum) return false
      if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) return false
      if (Number.isFinite(schema.maximum) && value > schema.maximum) return false
      if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) return false
      return true
    }
    return typeof value === type
  })
}

function schemaFallback(schema) {
  for (const key of ['default', 'const']) {
    if (Object.hasOwn(schema ?? {}, key) && schemaAcceptsValue(schema[key], schema)) {
      return { found: true, value: schema[key] }
    }
  }
  const values = Array.isArray(schema?.enum) ? schema.enum.filter((value) => value !== null) : []
  return values.length === 1 ? { found: true, value: values[0] } : { found: false }
}

function coerceScalarBySchema(value, schema, allowOmit) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const types = schemaTypes(schema)
    const integer = types.includes('integer') && !types.includes('number')
    let bounded = value
    if (Number.isFinite(schema?.minimum)) bounded = Math.max(bounded, schema.minimum)
    if (Number.isFinite(schema?.maximum)) bounded = Math.min(bounded, schema.maximum)
    if (integer && Number.isFinite(schema?.exclusiveMinimum) && bounded <= schema.exclusiveMinimum) {
      bounded = Math.floor(schema.exclusiveMinimum) + 1
    }
    if (integer && Number.isFinite(schema?.exclusiveMaximum) && bounded >= schema.exclusiveMaximum) {
      bounded = Math.ceil(schema.exclusiveMaximum) - 1
    }
    if (!Object.is(bounded, value) && schemaAcceptsValue(bounded, schema)) {
      return { value: bounded, changed: true }
    }
  }
  if (schemaAcceptsValue(value, schema)) return { value, changed: false }
  if (typeof value === 'string' && Array.isArray(schema?.enum)) {
    const matches = schema.enum.filter((item) => typeof item === 'string' && item.toLowerCase() === value.trim().toLowerCase())
    if (matches.length === 1) return { value: matches[0], changed: true }
    // Some streamed function arguments have arrived with the start of the
    // next JSON field appended to an otherwise valid enum value, for example
    // `in_progress\"},{\"content:`. Recover only an unambiguous enum prefix
    // followed by JSON structural punctuation. Never use fuzzy matching for
    // ordinary invalid values, because that could silently change intent.
    const trimmed = value.trim()
    const leakedMatches = schema.enum.filter((item) => {
      if (typeof item !== 'string' || !trimmed.startsWith(item)) return false
      const suffix = trimmed.slice(item.length)
      return suffix.length > 0 && /^[\s\\]*["'}\],:]/.test(suffix)
    })
    if (leakedMatches.length === 1) return { value: leakedMatches[0], changed: true }

    // Native Gemini function arguments can occasionally append an internal
    // presentation/control marker directly to a valid enum token, for example
    // `completedhidden` or `in_progressghost`. Recover only when one declared
    // enum is the unique longest prefix and the suffix is an ASCII marker,
    // either attached or separated only by whitespace. Delimited values such
    // as `in_progress_extra` remain untouched so
    // application-specific invalid values are not silently reinterpreted.
    const markerMatches = schema.enum
      .filter((item) => typeof item === 'string' && trimmed.startsWith(item))
      .map((item) => ({ item, suffix: trimmed.slice(item.length) }))
      .filter(({ item, suffix }) => (
        item.length >= 3
        && (/^[A-Za-z0-9]+$/.test(suffix) || /^\s+[A-Za-z][A-Za-z0-9-]*$/.test(suffix))
      ))
      .sort((left, right) => right.item.length - left.item.length)
    if (markerMatches.length && markerMatches[0].item.length > (markerMatches[1]?.item.length ?? -1)) {
      return { value: markerMatches[0].item, changed: true }
    }
  }
  for (const type of schemaTypes(schema)) {
    if (type === 'boolean' && typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true' || normalized === 'false') return { value: normalized === 'true', changed: true }
    }
    if ((type === 'integer' || type === 'number') && typeof value === 'string' && value.trim()) {
      const converted = Number(value)
      if (Number.isFinite(converted) && (type !== 'integer' || Number.isInteger(converted))) {
        const repaired = coerceScalarBySchema(converted, schema, allowOmit)
        if (!repaired.omitted && schemaAcceptsValue(repaired.value, schema)) {
          return { value: repaired.value, changed: true }
        }
      }
    }
    if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
      return { value: String(value), changed: true }
    }
  }
  return allowOmit
    ? { value: OMIT_TOOL_ARGUMENT, changed: true, omitted: true }
    : { value, changed: false }
}

function repairArgumentsBySchema(value, schema, fallbackDescription, allowOmit = true) {
  if (!schema || typeof schema !== 'object') return { value, changed: false }
  const variants = schemaVariants(schema)
  if (variants.length) {
    const accepted = variants.find((variant) => schemaAcceptsValue(value, variant))
    if (accepted) return repairArgumentsBySchema(value, accepted, fallbackDescription)
    for (const variant of variants) {
      const repaired = repairArgumentsBySchema(value, variant, fallbackDescription)
      if (!repaired.omitted && schemaAcceptsValue(repaired.value, variant)) return repaired
    }
    return allowOmit
      ? { value: OMIT_TOOL_ARGUMENT, changed: true, omitted: true }
      : { value, changed: false }
  }
  if (value === null && !schemaAcceptsValue(value, schema)) {
    const fallback = schemaFallback(schema)
    return fallback.found
      ? { value: fallback.value, changed: true }
      : allowOmit
        ? { value: OMIT_TOOL_ARGUMENT, changed: true, omitted: true }
        : { value, changed: false }
  }
  if (schemaTypes(schema).includes('array') && Array.isArray(value)) {
    let changed = false
    const repaired = []
    for (const item of value) {
      const nested = repairArgumentsBySchema(item, schema.items, fallbackDescription, true)
      if (nested.omitted) {
        changed = true
        continue
      }
      repaired.push(nested.value)
      changed ||= nested.changed
    }
    return { value: changed ? repaired : value, changed }
  }
  if (schemaTypes(schema).includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : undefined
    if (!properties) return { value, changed: false }
    const requiredProperties = new Set(Array.isArray(schema.required) ? schema.required : [])
    let changed = false
    const repaired = {}
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key]
      if (!propertySchema && schema.additionalProperties === false) {
        changed = true
        continue
      }
      const nested = repairArgumentsBySchema(item, propertySchema, fallbackDescription, !requiredProperties.has(key))
      if (nested.omitted) {
        changed = true
        continue
      }
      repaired[key] = nested.value
      changed ||= nested.changed
    }
    for (const required of requiredProperties) {
      const propertySchema = properties[required]
      if (
        required === 'description'
        && schemaTypes(propertySchema).includes('string')
        && !(typeof repaired.description === 'string' && repaired.description.trim())
      ) {
        repaired.description = fallbackDescription
        changed = true
        continue
      }
      if (repaired[required] !== undefined && repaired[required] !== null) continue
      const fallback = schemaFallback(propertySchema)
      if (fallback.found) {
        repaired[required] = fallback.value
        changed = true
      }
    }
    const hasMissingRequiredProperty = [...requiredProperties].some((required) => (
      repaired[required] === undefined
      || repaired[required] === null && !schemaAcceptsValue(null, properties[required])
    ))
    if (hasMissingRequiredProperty && allowOmit) {
      return { value: OMIT_TOOL_ARGUMENT, changed: true, omitted: true }
    }
    return { value: changed ? repaired : value, changed }
  }
  return coerceScalarBySchema(value, schema, allowOmit)
}

function splitTopLevelCommas(value) {
  const parts = []
  let braces = 0
  let brackets = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '{') braces += 1
    else if (char === '}') braces = Math.max(0, braces - 1)
    else if (char === '[') brackets += 1
    else if (char === ']') brackets = Math.max(0, brackets - 1)
    else if (char === ',' && braces === 0 && brackets === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function normalizeSingleGlobArguments(args, parameters) {
  const includeSchema = parameters?.properties?.include
  const description = String(includeSchema?.description ?? '').toLowerCase()
  if (
    typeof args.include !== 'string'
    || !(description.includes('one glob') || description.includes('not a list'))
  ) return { args, changed: false }
  const parts = splitTopLevelCommas(args.include)
  if (parts.length < 2 || parts.some((part) => !part || part.startsWith('!'))) return { args, changed: false }
  return { args: { ...args, include: `{${parts.join(',')}}` }, changed: true }
}

const SANDBOX_MODE_RANK = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

function removeNonWideningEscalation(args, currentSandboxMode) {
  const requested = args.sandbox_permissions
  if (!(requested in SANDBOX_MODE_RANK) || !(currentSandboxMode in SANDBOX_MODE_RANK)) {
    return { args, changed: false }
  }
  if (SANDBOX_MODE_RANK[requested] > SANDBOX_MODE_RANK[currentSandboxMode]) {
    return { args, changed: false }
  }
  const repaired = { ...args }
  delete repaired.sandbox_permissions
  delete repaired.justification
  return { args: repaired, changed: true }
}

function relativeTimeConstraints(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return []
  const patterns = [
    /(?:过去|近|最近)\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:分钟|小时|天|日|周|星期|个月|月|年)/giu,
    /(?:今天|今日|昨天|昨日|前天|本周|上周|本月|上月|今年|去年|最新|最近|当前|目前)/giu,
    /\b(?:past|last)\s+\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\b/giu,
    /\b(?:today|yesterday|the day before yesterday|this week|last week|this month|last month|this year|last year|latest|recent|recently|current|currently)\b/giu,
  ]
  return [...new Set(patterns.flatMap((pattern) => value.match(pattern) ?? []).map((match) => match.trim().toLowerCase()))]
}

function addTemporalContextToSearch(args, context) {
  if (typeof args.query !== 'string' || !args.query.trim()) return { args, changed: false }
  const constraints = relativeTimeConstraints(context.latestUserText)
  if (!constraints.length || /runtime temporal context:/i.test(args.query)) return { args, changed: false }
  const now = context.now instanceof Date && Number.isFinite(context.now.getTime()) ? context.now : new Date()
  const rollingWindow = requestedRollingWindow(constraints, now)
  const suffix = [
    `Runtime temporal context: ${runtimeDateAnchor(now)}.`,
    `Relative-time wording from the user: ${constraints.map((value) => `"${value}"`).join(', ')}.`,
    rollingWindow ? `Exact requested rolling window for "${rollingWindow.constraint}": ${runtimeDateAnchor(rollingWindow.start)} through ${runtimeDateAnchor(rollingWindow.end)}.` : '',
    'Apply the user\'s time constraint before selecting evidence. Do not substitute older news merely because it ranks highly.',
  ].filter(Boolean).join(' ')
  return { args: { ...args, query: `${args.query.trim()}\n\n${suffix}` }, changed: true }
}

function urlsInText(text) {
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`]+/giu)]
    .map((match) => match[0].replace(/[),.;:!?\]}，。；：！？]+$/u, ''))
}

export function collectPriorSearchSources(messages) {
  const sources = []
  const seen = new Set()
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block.type !== 'tool-result' || block.isError) continue
      const text = toolResultText(block)
      const patterns = [
        /^\d+\.\s+(https?:\/\/\S+?)(?:\s+—\s+(.+?))?\s+\[(?:google_search|url_context)\]\s*$/gmu,
        /^\[S\d+\]\s+(https?:\/\/\S+?)(?:\s+—\s+(.+?))?\s+\[(?:google_search|url_context)\]\s*$/gmu,
      ]
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          const uri = match[1]
          if (seen.has(uri)) continue
          seen.add(uri)
          sources.push({ uri, title: (match[2] ?? '').trim() })
        }
      }
    }
  }
  return sources
}

export function collectPriorClaimVerifications(messages) {
  let latest = []
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block.type !== 'tool-result' || block.isError) continue
      const text = toolResultText(block)
      if (!text.includes('Claim verification evidence packet')) continue
      const sourceById = new Map()
      for (const match of text.matchAll(/^\[S(\d+)\]\s+(https?:\/\/\S+?)(?:\s+—\s+.*?)?\s+\[(?:google_search|url_context)\]\s*$/gmu)) {
        sourceById.set(`S${match[1]}`, match[2])
      }
      const parsed = []
      const pattern = /^\[(V\d+)\]\s+(VERIFIED|PARTIAL|UNSUPPORTED|CONFLICTING|UNREACHABLE):\s*([\s\S]*?)\n\s+Sources:\s*([^\n]*)/gmu
      for (const match of text.matchAll(pattern)) {
        parsed.push({
          id: match[1],
          status: match[2],
          claim: match[3].replace(/\s+/g, ' ').trim(),
          sourceUrls: [...new Set((match[4].match(/S\d+/g) ?? []).map((id) => sourceById.get(id)).filter(Boolean))],
        })
      }
      if (parsed.length) latest = parsed
    }
  }
  return latest
}

function normalizedClaimText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>()|]+/giu, ' ')
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function claimShingles(value, size = 3) {
  const normalized = normalizedClaimText(value)
  if (!normalized) return new Set()
  if (normalized.length <= size) return new Set([normalized])
  return new Set(Array.from({ length: normalized.length - size + 1 }, (_value, index) => normalized.slice(index, index + size)))
}

function claimSimilarity(left, right) {
  const normalizedLeft = normalizedClaimText(left)
  const normalizedRight = normalizedClaimText(right)
  if (!normalizedLeft || !normalizedRight) return 0
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 1
  const leftShingles = claimShingles(normalizedLeft)
  const rightShingles = claimShingles(normalizedRight)
  const intersection = [...leftShingles].filter((item) => rightShingles.has(item)).length
  return intersection / Math.max(1, Math.min(leftShingles.size, rightShingles.size))
}

function verificationStatusLabel(status) {
  if (status === 'VERIFIED') return '**VERIFIED / 已核**'
  if (status === 'PARTIAL') return '**PARTIAL（仅部分支持，须按核验结果缩窄）**'
  if (status === 'UNSUPPORTED') return '**UNSUPPORTED（来源不支持）**'
  if (status === 'CONFLICTING') return '**CONFLICTING（来源存在冲突）**'
  if (status === 'UNREACHABLE') return '**UNREACHABLE（来源无法访问）**'
  return '**UNVERIFIED（未提交严格核验）**'
}

function replaceVerificationStatusLabel(row, status) {
  const token = /\*{0,2}\s*(?:(?:VERIFIED|PARTIAL|UNSUPPORTED|CONFLICTING|UNREACHABLE|UNVERIFIED)(?:\s*\([^|\n]*\))?|已核(?:（[^|\n]*）)?|待核(?:（[^|\n]*）)?)\s*\*{0,2}/iu
  const pair = new RegExp(`${token.source}(?:\\s*\\/\\s*${token.source})?`, 'iu')
  return row.replace(pair, verificationStatusLabel(status))
}

function neutralizeVerificationNarrative(row, status) {
  if (status === 'VERIFIED') return row
  const explanation = status === 'PARTIAL'
    ? '仅部分支持；须按严格核验结果缩窄表述。'
    : status === 'UNSUPPORTED'
      ? '来源不支持该完整表述；不得作为已核事实。'
      : status === 'CONFLICTING'
        ? '来源相互冲突；不得作为已核事实。'
        : status === 'UNREACHABLE'
          ? '严格核验时来源无法访问；不得作为已核事实。'
          : '未提交 `gemini_verify_claims` 严格核验；不得作为已核事实。'
  const cells = row.split('|')
  const statusIndex = cells.findIndex((cell) => /(?:VERIFIED|PARTIAL|UNSUPPORTED|CONFLICTING|UNREACHABLE|UNVERIFIED|已核|待核)/iu.test(cell))
  if (statusIndex < 0) return row
  return cells.map((cell, index) => {
    if (index <= statusIndex) return cell
    return cell
      .replace(/\*{0,2}(?:精确|精准|完全|直接)?支持(?:（[^|\n]*）|\([^|\n]*\))?[。.]?\*{0,2}/giu, explanation)
      .replace(/(?:均已|已经|已)(?:通过|完成)(?:严格)?(?:事实)?核验/gu, explanation)
  }).join('|')
}

function verificationAuditTable(outcomes) {
  const rows = outcomes.map((outcome) => {
    const claim = outcome.claim.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
    const sources = outcome.sourceUrls.length ? outcome.sourceUrls.join('<br>') : '未返回可访问的精确来源 URL'
    return `| ${outcome.id} | ${outcome.status} | ${claim} | ${sources} |`
  })
  return [
    '## 适配器严格核验结果（自动审计）',
    '',
    '> 以下状态直接继承自最新一次 `gemini_verify_claims`，用于防止将部分支持、未支持或无法访问的事实误写为“已核”。',
    '',
    '| 核验编号 | 原始状态 | 提交核验的事实 | 精确来源 URL |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n')
}

function guardFactCheckVerificationStatus(name, args, context) {
  if (!['write', 'edit'].includes(name)) return { args, changed: false }
  const field = name === 'write' ? 'content' : 'new_string'
  const original = args[field]
  const outcomes = context.priorClaimVerifications ?? []
  if (typeof original !== 'string' || !outcomes.length || !/(?:事实核查|核查表|fact.?check)/iu.test(original)) {
    return { args, changed: false }
  }
  const represented = new Set()
  let foundConflict = false
  const lines = original.split(/\r?\n/).map((line) => {
    if (!/^\s*\|.*\|\s*$/u.test(line) || !/(?:VERIFIED|PARTIAL|UNSUPPORTED|CONFLICTING|UNREACHABLE|UNVERIFIED|已核|待核)/iu.test(line)) return line
    const rowNumber = line.match(/^\s*\|\s*\*{0,2}(?:V\s*)?(\d+)\b/iu)?.[1]
    const numbered = rowNumber
      ? outcomes.map((outcome, index) => ({ outcome, index })).find(({ outcome }) => outcome.id === `V${rowNumber}` && outcome.sourceUrls.some((uri) => line.includes(uri)))
      : undefined
    const ranked = outcomes
      .map((outcome, index) => ({ outcome, index, score: claimSimilarity(line, outcome.claim) }))
      .sort((left, right) => right.score - left.score)
    const best = numbered ? { ...numbered, score: 1 } : ranked[0]
    if (!best || best.score < 0.45) {
      foundConflict = true
      return neutralizeVerificationNarrative(replaceVerificationStatusLabel(line, 'UNVERIFIED'), 'UNVERIFIED')
    }
    represented.add(best.index)
    const exactSourcePresent = best.outcome.sourceUrls.some((uri) => line.includes(uri))
    if (best.outcome.status === 'VERIFIED' && exactSourcePresent) return replaceVerificationStatusLabel(line, 'VERIFIED')
    foundConflict = true
    const status = best.outcome.status === 'VERIFIED' ? 'UNVERIFIED' : best.outcome.status
    return neutralizeVerificationNarrative(replaceVerificationStatusLabel(line, status), status)
  })
  let guarded = lines.join('\n')
  const missing = outcomes.filter((_outcome, index) => !represented.has(index))
  if (foundConflict || missing.length) {
    guarded = guarded
      .replace(/^.*所有引用事实.*(?:VERIFIED|已核).*$/gmu, '核验状态以文末“适配器严格核验结果”为准；不得将部分支持、未支持、冲突或无法访问的事实标记为已核。')
      .replace(/全部事实(?:验证|核查)通过/gu, '并非全部事实均通过严格核验')
    if (!guarded.includes('## 适配器严格核验结果（自动审计）')) {
      guarded = `${guarded.trimEnd()}\n\n${verificationAuditTable(outcomes)}\n`
    }
  }
  return guarded === original ? { args, changed: false } : { args: { ...args, [field]: guarded }, changed: true }
}

function referencedPriorSourceUrl(latestUserText, sources) {
  const text = String(latestUserText ?? '').toLowerCase()
  if (!sources?.length || !/(?:刚才|上述|上面|此前|前述|来源|链接|页面|previous|above|earlier|source|link|page)/iu.test(text)) return undefined
  const ordinalPatterns = [
    /(?:第\s*一|首个|第一个|first)\s*(?:个)?(?:来源|链接|页面|source|link|page)?/iu,
    /(?:第\s*二|第二个|second)\s*(?:个)?(?:来源|链接|页面|source|link|page)?/iu,
    /(?:第\s*三|第三个|third)\s*(?:个)?(?:来源|链接|页面|source|link|page)?/iu,
  ]
  const ordinal = ordinalPatterns.findIndex((pattern) => pattern.test(text))
  if (ordinal >= 0 && sources[ordinal]) return sources[ordinal].uri
  const scored = sources.map((source) => {
    const tokens = String(source.title ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    return { source, score: tokens.filter((token) => token.length >= 3 && text.includes(token)).length }
  }).sort((left, right) => right.score - left.score)
  if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score ?? 0)) return scored[0].source.uri
  return sources.length === 1 ? sources[0].uri : undefined
}

function addPriorSourceContextToSearch(args, context) {
  if (typeof args.query !== 'string' || !args.query.trim() || /https?:\/\/[^\s<>()]+/i.test(args.query)) return { args, changed: false }
  const uri = referencedPriorSourceUrl(context.latestUserText, context.priorSearchSources)
  if (!uri) return { args, changed: false }
  return {
    args: { ...args, query: `${args.query.trim()}\n\nExact prior source URL requested by the user: ${uri}` },
    changed: true,
  }
}

function normalizeJsonFileContent(args) {
  const filePath = typeof args.file_path === 'string'
    ? args.file_path
    : typeof args.path === 'string'
      ? args.path
      : ''
  if (!/\.json$/iu.test(filePath) || typeof args.content !== 'string') return { args, changed: false }
  try {
    JSON.parse(args.content)
    return { args, changed: false }
  } catch {
    // Continue only when the entire document may have been serialized as the
    // contents of a JSON string, e.g. `[\n {\"name\": ...}\n]`.
  }
  try {
    const decoded = JSON.parse(`"${args.content}"`)
    JSON.parse(decoded)
    return { args: { ...args, content: decoded }, changed: true }
  } catch {
    return { args, changed: false }
  }
}

function guardResearchCitationUrls(name, args, context) {
  if (!['write', 'edit'].includes(name)) return { args, changed: false }
  const sources = context.priorSearchSources ?? []
  const researchLike = /(?:核查|核实|事实|来源|链接|引用|研究|报告|新闻|最新|verify|fact.?check|citation|source|research|report)/iu.test(context.latestUserText ?? '')
  if (!sources.length || !researchLike) return { args, changed: false }
  const allowed = new Set(sources.map((source) => source.uri))
  for (const uri of urlsInText(context.latestUserText)) allowed.add(uri)
  const fields = name === 'write' ? ['content'] : ['new_string']
  let repaired = args
  let changed = false
  for (const field of fields) {
    if (typeof repaired[field] !== 'string') continue
    const original = repaired[field]
    let guarded = original.replace(/https?:\/\/[^\s<>"'`]+/giu, (raw) => {
      const suffixMatch = raw.match(/[),.;:!?\]}，。；：！？]+$/u)
      const suffix = suffixMatch?.[0] ?? ''
      const uri = suffix ? raw.slice(0, -suffix.length) : raw
      if (allowed.has(uri)) return raw
      changed = true
      return `[unverified URL omitted]${suffix}`
    })
    if (guarded !== original && /(?:事实核查|核查表|fact.?check)/iu.test(original)) {
      guarded = guarded
        .replace(/全部事实(?:验证|核查)通过/gu, '存在来源 URL 未通过白名单，不能认定全部事实验证通过')
        .replace(/\|\s*已核(?:（[^|\n]*）)?\s*\|/gu, '| 待核（来源 URL 未通过白名单） |')
        .replace(/\|\s*VERIFIED(?:\s*\([^|\n]*\))?\s*\|/giu, '| UNVERIFIED (source URL was not in the evidence whitelist) |')
    }
    if (guarded !== repaired[field]) repaired = { ...repaired, [field]: guarded }
  }
  return { args: repaired, changed }
}

function containsExternalWebCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false
  const explicitUrls = command.match(/https?:\/\/[^\s"'`]+/giu) ?? []
  if (explicitUrls.length && explicitUrls.every((url) => /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/iu.test(url))) {
    return false
  }
  return /(?:\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bStart-BitsTransfer\b|\b(?:iwr|irm)\s+(?:-[\w-]+\s+)*(?:https?:\/\/|['"]https?:\/\/)|\b(?:curl|curl\.exe|wget|wget\.exe)\b|urllib(?:\.request)?|\burlopen\s*\(|\brequests\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\bhttpx\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\bfetch\s*\(\s*['"]https?:\/\/|https?\s*\.\s*request\s*\(|System\.Net\.(?:WebClient|HttpClient|WebRequest))/iu.test(command)
}

function guardExternalWebFallback(name, args, context = {}) {
  if (name !== 'pwsh' || !context.blockExternalWebFallback || !containsExternalWebCommand(args.command)) {
    return { args, changed: false }
  }
  return {
    args: {
      ...args,
      command: "throw 'External web fallback through PowerShell is disabled after Gemini native search failed.'",
      description: 'Block external web fallback after Gemini native search failure',
    },
    changed: true,
  }
}

export function normalizeToolArguments(name, rawArguments, parameters, context = {}) {
  let args
  if (typeof rawArguments === 'string') {
    try { args = JSON.parse(rawArguments || '{}') } catch { return rawArguments }
  } else {
    args = rawArguments
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return rawArguments

  const readableName = String(name || 'tool').replace(/[_-]+/g, ' ').trim() || 'tool'
  const fallbackDescription = `Execute the requested ${readableName} operation`
  const schemaRepair = repairArgumentsBySchema(args, parameters, fallbackDescription, false)
  args = schemaRepair.value
  let changed = schemaRepair.changed

  const globRepair = normalizeSingleGlobArguments(args, parameters)
  args = globRepair.args
  changed ||= globRepair.changed

  const escalationRepair = removeNonWideningEscalation(args, context.currentSandboxMode)
  args = escalationRepair.args
  changed ||= escalationRepair.changed

  if (args.justification !== undefined && args.sandbox_permissions === undefined) {
    args = { ...args }
    delete args.justification
    changed = true
  }

  const jsonContentRepair = normalizeJsonFileContent(args)
  args = jsonContentRepair.args
  changed ||= jsonContentRepair.changed

  if (name === 'pwsh') {
    if (typeof args.command === 'string' && args.command.trim() && !(typeof args.description === 'string' && args.description.trim())) {
      args = { ...args, description: 'Run PowerShell command' }
      changed = true
    }
    const externalWebGuard = guardExternalWebFallback(name, args, context)
    args = externalWebGuard.args
    changed ||= externalWebGuard.changed
  }

  if (name === 'update_goal' && args.action !== 'edit') {
    // dsh accepts objective/max_goal_rounds only for an edit. Gemini often
    // repeats the original objective while completing the goal, which turns
    // an otherwise valid completion into a deterministic tool error.
    const repaired = { ...args }
    if ('objective' in repaired) { delete repaired.objective; changed = true }
    if ('max_goal_rounds' in repaired) { delete repaired.max_goal_rounds; changed = true }
    args = repaired
  }

  if (name === GEMINI_WEB_SEARCH_TOOL) {
    const temporalRepair = addTemporalContextToSearch(args, context)
    args = temporalRepair.args
    changed ||= temporalRepair.changed
    const priorSourceRepair = addPriorSourceContextToSearch(args, context)
    args = priorSourceRepair.args
    changed ||= priorSourceRepair.changed
  }

  const citationGuard = guardResearchCitationUrls(name, args, context)
  args = citationGuard.args
  changed ||= citationGuard.changed

  const verificationGuard = guardFactCheckVerificationStatus(name, args, context)
  args = verificationGuard.args
  changed ||= verificationGuard.changed

  if (!changed) return rawArguments
  return typeof rawArguments === 'string' ? JSON.stringify(args) : args
}

export function shouldUseOpenAICompatibility(options = {}) {
  const latestUser = [...(options.messages ?? [])].reverse().find((message) => message.role === 'user')
  const latestText = latestUser?.content?.filter((block) => block.type === 'text' || block.type === 'reasoning').map((block) => block.text).join('') ?? ''
  const hasFile = latestUser?.content?.some((block) => block.type === 'image') || extractGeminiFilePaths(latestText).length > 0 || Boolean(extractPdfPath(latestText))
  const hasToolHistory = (options.messages ?? []).some((message) => (message.content ?? []).some((block) => ['tool-call', 'tool-result'].includes(block.type)))
  return (Boolean(options.tools?.length) || hasToolHistory) && !hasFile
}

const GEMINI_WEB_SEARCH_TOOL = 'gemini_web_search'
const GEMINI_VERIFY_CLAIMS_TOOL = 'gemini_verify_claims'
const GEMINI_WEB_SEARCH_TIMEOUT_MS = 240_000
const GEMINI_VERIFY_CLAIMS_TIMEOUT_MS = 900_000
function runtimeDateAnchor(now = new Date()) {
  const value = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()
  const localDate = [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
  const localTime = [String(value.getHours()).padStart(2, '0'), String(value.getMinutes()).padStart(2, '0'), String(value.getSeconds()).padStart(2, '0')].join(':')
  const offsetMinutes = -value.getTimezoneOffset()
  const offsetSign = offsetMinutes >= 0 ? '+' : '-'
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || `UTC${offsetSign}${offsetHours}:${offsetRemainder}`
  return `${localDate} ${localTime} (${timezone}, UTC${offsetSign}${offsetHours}:${offsetRemainder})`
}

function parseTemporalAmount(raw) {
  const value = String(raw ?? '').trim()
  if (/^\d+$/.test(value)) return Number(value)
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value === '十') return 10
  const tens = value.match(/^([一二两三四五六七八九]?)十([一二两三四五六七八九]?)$/u)
  if (tens) return (digits[tens[1]] ?? 1) * 10 + (digits[tens[2]] ?? 0)
  return digits[value]
}

function requestedRollingWindow(constraints, now = new Date()) {
  const value = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()
  const unitMilliseconds = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
  }
  for (const constraint of constraints) {
    const chinese = constraint.match(/^(?:过去|近|最近)\s*(\d+|[一二两三四五六七八九十]+)\s*(分钟|小时|天|日|周|星期|个月|月|年)$/iu)
    const english = constraint.match(/^(?:past|last)\s+(\d+)\s+(minutes?|hours?|days?|weeks?|months?|years?)$/iu)
    const amount = chinese ? parseTemporalAmount(chinese[1]) : Number(english?.[1])
    if (!Number.isFinite(amount) || amount <= 0) continue
    const rawUnit = chinese?.[2] ?? english?.[2].toLowerCase()
    const unit = /分钟|minute/.test(rawUnit) ? 'minute'
      : /小时|hour/.test(rawUnit) ? 'hour'
        : /天|日|day/.test(rawUnit) ? 'day'
          : /周|星期|week/.test(rawUnit) ? 'week'
            : /个月|月|month/.test(rawUnit) ? 'month'
              : 'year'
    const start = new Date(value)
    if (unitMilliseconds[unit]) start.setTime(value.getTime() - amount * unitMilliseconds[unit])
    else if (unit === 'month') start.setMonth(start.getMonth() - amount)
    else start.setFullYear(start.getFullYear() - amount)
    return { constraint, start, end: value }
  }
  return undefined
}

const SEARCH_CONVERGENCE_POLICY = [
  'Gemini web lookup rules:',
  `- Use ${GEMINI_WEB_SEARCH_TOOL} for every web search or public URL lookup. It uses Gemini native Google Search and URL Context.`,
  '- Never request the legacy web_search or web_fetch tools; they are intentionally unavailable to this provider.',
  '- For an explicit URL or a uniquely identifiable target such as a GitHub owner/repository, package coordinate, DOI, CVE, or exact error text, pass the complete target in one precise query.',
  '- For an exact target whose canonical identity is missing, use one quoted-name discovery lookup with the relevant category or domain. Once a unique owner, package coordinate, DOI, CVE, or canonical URL is found, stop paraphrasing the query and use that identifier or URL for the next lookup.',
  '- Verify the requested claim on the canonical primary page whenever one is available. Discovery results establish identity; the primary page establishes the final fact.',
  '- Copy every cited URL exactly from a successful lookup result. Never guess, concatenate, repair, or autocomplete a URL. A search-result snippet, generic home page, category page, or merely related article is not evidence for a specific claim.',
  '- When the user requests sources, links, citations, or verification, the final answer must include at least one exact URL returned by a successful lookup. A source name, publication title, or claim that research was performed is not a citation.',
  '- Treat a claim as verified only when the retrieved page directly supports its subject, date, quantity, and scope. If the page is inaccessible, ambiguous, contradictory, or only partially supportive, say so, narrow the claim, find a better source, or omit it; never label it verified.',
  '- Prefer authoritative primary sources for material claims and use an independent corroborating source when the claim is consequential, disputed, or unusually precise. Preserve source disagreements instead of silently choosing the most convenient value.',
  '- Preserve evidence status: a company or government announcement, an attributed analyst opinion, channel checks, an unnamed-source report, and the model\'s inference are different claim types. Never upgrade analysis, expectation, evaluation, or rumor into a confirmed decision, order, deployment, or official act.',
  '- Do not combine separate reports into a new causal relationship, transaction, partnership, or coordinated event unless at least one retrieved source explicitly establishes that relationship. Cite each material claim only to the source passages that directly support it.',
  '- For precise numbers, names, dates, and technical specifications, prefer the original-language primary source when translations or secondary reports disagree, and disclose the disagreement rather than silently selecting one value.',
  `- Before labeling a factual claim "verified", "已核", "confirmed", or equivalent in a research deliverable, call ${GEMINI_VERIFY_CLAIMS_TOOL} with the material claim and exact source URLs returned by prior grounded lookups. Unsupported, partial, conflicting, or unreachable claims must be narrowed, qualified, or omitted.`,
  '- Before claim verification, build an atomic claim inventory from the intended deliverable rather than submitting a small representative sample. Include every consequential date, quantity, named institution, named project or case, policy identifier, technical specification, deployment, attributed action, and claimed outcome. The number of claims must follow the factual density of the deliverable, not a fixed target.',
  `- Submit that complete material-claim inventory to ${GEMINI_VERIFY_CLAIMS_TOOL}; the adapter safely batches large inventories internally. Do not reduce the inventory merely to shorten the tool call.`,
  '- A fact-check table must map every submitted material claim to its verification status and supporting exact URL. Do not silently omit failed or inconvenient rows. Never claim "all verified", "double sourced", or "zero drift" unless the verification results actually establish complete coverage of the deliverable.',
  '- Every verified row in a fact-check table must include the exact whitelist URL used by claim verification. A source name, guessed site home page, or omitted URL cannot support a VERIFIED/已核 status.',
  '- Never invent a generation timestamp. Use a successful runtime/time tool result when an exact timestamp matters; otherwise omit the timestamp.',
  '- For current, latest, or recent claims, compare both publication dates and event dates. Do not present an older event as current merely because a page was republished or newly indexed.',
  '- Resolve relative time expressions such as today, yesterday, the past 24 hours, this week, latest, and recent against the runtime date anchor supplied below. Put the resulting absolute date range in the search query. Do not guess a month, year, or cutoff from model memory.',
  '- Never replace an unverified exact target with similarly named projects, and never claim that the target does not exist unless the lookup evidence establishes that. Ask for the owner or URL when identity remains ambiguous.',
  '- Do not equate "do not browse/search/reconnect to the web" with "do not use tools". It disables gemini_web_search only. Continue using relevant non-network local dsh tools for deterministic computation, runtime or environment state, workspace and file inspection, transformations, and result verification unless the user explicitly forbids all tool calls or the operation exceeds the requested scope or permissions.',
  '- Do not use shell commands, package-manager commands, scripts, or local browser tools to access public websites, registries, or APIs as a substitute for gemini_web_search.',
  '- Treat a successful non-network tool result as authoritative for the facts it contains. As soon as the result supplies enough evidence to answer, stop calling tools and answer from it. Never rerun a semantically equivalent local operation merely to reconfirm the same value; retry only when the prior result is unusable or materially contradictory, and explain that reason.',
  '- For broad workspace discovery, search likely source, configuration, and documentation paths first. Ignore hidden caches, dependency trees, generated artifacts, and binaries unless the request concerns them; do not inspect unrelated matches one by one after enough relevant evidence is available.',
  '- If two independent local discovery attempts both return empty or no-result evidence, stop probing equivalent locations and ask for the missing workspace, path, or identifier. Do not cycle through glob, grep, shell, and read variants hoping the same absent target appears.',
  `- Do not repeat identical or near-identical ${GEMINI_WEB_SEARCH_TOOL} queries. After an irrelevant result, refine once, then answer from the available evidence or state that the target was not found.`,
].join('\n')

const AGENT_EXECUTION_POLICY = [
  'Gemini agent execution rules:',
  '- Keep private analysis and reasoning out of normal answer text. Normal text must be concise, user-facing progress or a completed result.',
  '- Never emit, imitate, or summarize internal runtime notifications such as "A previously requested tool execution completed" as normal answer text. Treat them only as execution context, then continue the task or provide a user-facing result.',
  '- Keep every tool call as one valid JSON object. Never place provider control markers or a second tool-call protocol inside another tool\'s arguments; use a later model step when another call is needed.',
  '- Before every tool call, check the supplied JSON Schema: include every required property, use the declared types and enum values, and omit unsupported fields. If a required value is not grounded in the request or tool evidence, inspect first or ask the user; never knowingly send an incomplete call or invent a value.',
  '- A failed tool result is not progress and does not verify anything. Read the exact error, change the relevant arguments or approach, and retry at most once unless new evidence justifies another attempt. Claim completion or verification only after a successful result demonstrates it.',
  '- For generated files or transformed artifacts, use an available read, validation, render, or inspection tool before declaring them correct. File existence alone proves neither content quality nor format correctness.',
  '- When a long report or other deliverable has been written to files, keep the final answer short: list the actual output files, summarize validation status, and mention genuine limitations. Do not paste the entire deliverable or a long fact-check table back into the chat.',
  '- Use a settled subagent report directly. A subagent identifier is not a background-job identifier; call job tools only with an ID returned by a job-starting tool.',
  '- When the request still requires tool work and a relevant tool is available, call that tool instead of ending the turn with a plan describing what you will inspect next.',
  '- End the turn only after completing the requested work, reaching a genuine blocker that requires user input, or determining that no available tool can make further progress.',
].join('\n')

const TASK_LIST_POLICY = [
  'Task-list progress rules:',
  '- Treat the latest successful task-list write as the canonical list. Preserve item wording and order unless the requested scope genuinely changes; never rewrite the same list merely to restate or rename it.',
  '- Do not call the task-list tool unless at least one status or the real task scope changed.',
  '- As soon as an item finishes, send the entire list with that item completed and the next active item in_progress before continuing later sequential work. Mark multiple items in_progress only while their work actually runs concurrently.',
  '- Before the final answer, send one final entire-list update: every finished item must be completed and no item may remain in_progress. Never report completed work while its task-list item is still pending or in_progress.',
].join('\n')

function isTaskListTool(tool) {
  const name = String(tool?.name ?? '').toLowerCase()
  const description = String(tool?.description ?? '').toLowerCase()
  const properties = tool?.parameters?.properties
  const collection = properties?.todos ?? properties?.tasks ?? properties?.items
  const statuses = collection?.items?.properties?.status?.enum
  const hasProgressStatuses = Array.isArray(statuses)
    && ['pending', 'in_progress', 'completed'].every((status) => statuses.includes(status))
  return /(?:todo|task).*(?:write|update|plan)|(?:write|update).*(?:todo|task)/.test(name)
    || description.includes('structured task list')
    || hasProgressStatuses
}

function taskListWriteAwaitingProgress(messages, taskToolNames) {
  let turnStart = 0
  for (let index = messages?.length - 1; index >= 0; index -= 1) {
    if (isHumanUserMessage(messages[index])) { turnStart = index; break }
  }
  const callNames = new Map()
  let awaitingProgress = false
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.id && block.name) {
        callNames.set(block.id, block.name)
      } else if (block.type === 'tool-result') {
        const callName = callNames.get(block.toolCallId ?? block.id)
        if (!callName || block.isError) continue
        if (taskToolNames.has(callName)) awaitingProgress = true
        else awaitingProgress = false
      }
    }
  }
  return awaitingProgress
}

export function prepareAgentExecution(options = {}) {
  if (!(options.tools?.length)) return options
  const taskTools = options.tools.filter(isTaskListTool)
  const taskToolNames = new Set(taskTools.map((tool) => tool.name))
  const awaitingTaskProgress = taskToolNames.size > 0
    && taskListWriteAwaitingProgress(options.messages, taskToolNames)
  const policies = [options.system, AGENT_EXECUTION_POLICY]
  if (taskTools.length) policies.push(TASK_LIST_POLICY)
  if (awaitingTaskProgress) {
    policies.push('The task-list tool is temporarily unavailable because its latest successful write has no intervening non-task tool result. Continue the actual work now; task-list updates become available again after real tool progress.')
  }
  return {
    ...options,
    system: policies.filter(Boolean).join('\n\n'),
    tools: awaitingTaskProgress
      ? options.tools.filter((tool) => !taskToolNames.has(tool.name))
      : options.tools,
  }
}

function isHumanUserMessage(message) {
  if (message?.role !== 'user') return false
  // dsh represents runtime snapshots, skill catalogs, subagent reports, and
  // tool results as role=user messages too. They must not replace the actual
  // user turn when deriving temporal constraints or attachment ownership.
  const sourceKind = message.source?.kind
  if (sourceKind && sourceKind !== 'user') return false
  const humanBlocks = (message.content ?? []).filter((block) => ['text', 'reasoning', 'image'].includes(block.type))
  if (!humanBlocks.length) return false
  const text = humanBlocks
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map((block) => block.text)
    .join('\n')
    .trimStart()
  // Older dsh builds may omit source metadata for injected runtime snapshots,
  // system reminders, and expanded skill bodies. Do not let those synthetic
  // role=user messages replace the user's actual request.
  if (/^(?:Current runtime context\.|<system-reminder>|<skill_content\b|Current image attachments\b)/iu.test(text)) return false
  return true
}

function runtimeSandboxMode(options = {}) {
  const values = [options.system]
  for (const message of options.messages ?? []) {
    for (const block of message.content ?? []) {
      if (typeof block?.text === 'string') values.push(block.text)
      if (Array.isArray(block?.content)) values.push(toolResultText(block))
    }
  }
  for (const value of values.reverse()) {
    const text = String(value ?? '')
    const policy = text.match(/Current DSH file policy:\s*(read-only|workspace-write|danger-full-access)\b/i)
    if (policy) return policy[1].toLowerCase()
    const failure = text.match(/current\s+"(read-only|workspace-write|danger-full-access)"\s+mode/i)
    if (failure) return failure[1].toLowerCase()
  }
  return undefined
}

function stableToolValue(value) {
  if (Array.isArray(value)) return value.map(stableToolValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableToolValue(value[key])]))
  }
  return value
}

function toolCallSignature(block) {
  let args = block.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return `${block.name}\n${args}` }
  }
  return `${block.name}\n${JSON.stringify(stableToolValue(args))}`
}

function trailingDuplicateTool(messages, turnStart) {
  const calls = (messages ?? []).slice(turnStart + 1)
    .flatMap((message) => (message.content ?? []).filter((block) => block.type === 'tool-call'))
    .filter((block) => block.name && block.name !== GEMINI_WEB_SEARCH_TOOL)
  if (calls.length < 2) return undefined
  const latest = calls.at(-1)
  const previous = calls.at(-2)
  return toolCallSignature(latest) === toolCallSignature(previous) ? latest.name : undefined
}

function toolResultText(block) {
  if (!Array.isArray(block?.content)) return ''
  return block.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim()
}

function isEmptyToolResult(block) {
  if (block?.type !== 'tool-result' || block.isError) return false
  const text = toolResultText(block)
  if (!text) return true
  return /^(?:\(no output\)|no (?:files?|matches?|results?|paths?) found|0 (?:files?|matches?|results?|paths?)|未找到(?:文件|匹配项|结果|路径)|没有(?:文件|匹配项|结果|路径)|0 个(?:文件|匹配项|结果|路径))\.?$/iu.test(text)
}

function emptyDiscoveryState(messages, turnStart) {
  const callById = new Map()
  const signatureById = new Map()
  const emptySignatures = new Set()
  let hasSubstantiveResult = false
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.id && block.name && block.name !== GEMINI_WEB_SEARCH_TOOL) {
        callById.set(block.id, block.name)
        signatureById.set(block.id, toolCallSignature(block))
      }
      if (block.type !== 'tool-result') continue
      const callId = block.toolCallId ?? block.id
      const toolName = callById.get(callId)
      if (!toolName || toolName === GEMINI_WEB_SEARCH_TOOL) continue
      if (isEmptyToolResult(block)) emptySignatures.add(signatureById.get(callId) ?? `${toolName}\n${callId}`)
      else if (!block.isError) hasSubstantiveResult = true
    }
  }
  return {
    shouldConverge: !hasSubstantiveResult && emptySignatures.size >= 2,
    count: emptySignatures.size,
  }
}

function recoverableFailureFingerprint(block) {
  if (!block?.isError) return undefined
  const text = toolResultText(block).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!/(?:invalid arguments?|missing required propert|must be (?:an?|one of)|expected (?:an?|type)|sandbox escalation .* not strictly wider|old_string was not found|include must be one glob|more raw output than .* cap|not lossless json|unknown job|job (?:id )?(?:was )?not found|caller does not have permission|rate.?limit|http 429|http 5\d\d|external web fallback through powershell is disabled)/.test(text)) return undefined
  return text
    .replace(/\[\d+\]/g, '[]')
    .replace(/\bcall[-_][a-z0-9_-]+\b/g, 'call')
    .slice(0, 500)
}

function recoveryGuidanceFor(toolName, text) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const missing = normalized.match(/missing required property\s+["']([^"']+)["']/i)
  if (missing) {
    const property = missing[1]
    if (property === 'content') {
      return `The last ${toolName} call omitted required property "content". Retry only after supplying the complete intended file content; use an explicit empty string only when an empty file is genuinely intended. Never guess or overwrite a file with invented content.`
    }
    return `The last ${toolName} call omitted required property "${property}". Retry only with a complete value grounded in the user request or current evidence; do not invent it.`
  }
  if (/sandbox escalation .* not strictly wider/i.test(normalized)) {
    return `The last ${toolName} call requested a sandbox mode that was not wider than the current mode. Omit sandbox_permissions and justification and retry under the standing mode. Request escalation only after an actual sandbox denial, and only to a strictly wider mode.`
  }
  if (/old_string was not found/i.test(normalized)) {
    return `The last ${toolName} edit used stale or inexact old text. Read the current target file, copy the exact current text into old_string, then retry once. Do not repeat the same replacement unchanged.`
  }
  if (/include must be one glob/i.test(normalized)) {
    return `The last ${toolName} call passed a comma-separated include list. Use one brace-alternation glob such as "*.{js,ts}" or "{src/**/*.js,test/**/*.js}".`
  }
  if (/more raw output than .* cap/i.test(normalized)) {
    return `The last ${toolName} search was too broad. Narrow the path, regular-expression pattern, or include glob before retrying; do not repeat an equivalent workspace-wide search.`
  }
  if (/not lossless json/i.test(normalized) && toolName === GEMINI_WEB_SEARCH_TOOL) {
    return `The last ${GEMINI_WEB_SEARCH_TOOL} call had no usable query. Retry with one non-empty, precise query containing the complete URL or identifier when available.`
  }
  if (toolName === GEMINI_WEB_SEARCH_TOOL && /caller does not have permission|rate.?limit|http 429|http 5\d\d/i.test(normalized)) {
    return `The last ${GEMINI_WEB_SEARCH_TOOL} call failed at the provider before returning evidence. Preserve the original time range and exact target, retry the same substantive lookup at most once, and do not treat the error as a search result. If the retry also fails, stop web lookup and report that current facts could not be verified.`
  }
  if (/external web fallback through powershell is disabled/i.test(normalized)) {
    return `External web access through PowerShell, Python, curl, or another shell is not a substitute for ${GEMINI_WEB_SEARCH_TOOL}. Do not retry with another command or search engine. Report that current web evidence could not be retrieved, while continuing only with genuinely local non-network work.`
  }
  if (/unknown job|job (?:id )?(?:was )?not found/i.test(normalized)) {
    return `The last ${toolName} call referenced a job identifier that the runtime no longer recognizes. Do not repeat the same identifier. Use an available agent-list or status tool to rediscover active work; if the registry entry is gone, continue the task directly or report the genuine blocker.`
  }
  return undefined
}

function toolFailureRecoveryState(messages, turnStart, threshold = 2) {
  const callNames = new Map()
  const failuresByTool = new Map()
  const guidanceByTool = new Map()
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.id && block.name) {
        callNames.set(block.id, block.name)
        continue
      }
      if (block.type !== 'tool-result') continue
      const toolName = callNames.get(block.toolCallId ?? block.id)
      if (!toolName) continue
      if (!block.isError) {
        failuresByTool.delete(toolName)
        continue
      }
      const text = toolResultText(block)
      const guidance = recoveryGuidanceFor(toolName, text)
      if (guidance) guidanceByTool.set(toolName, guidance)
      const fingerprint = recoverableFailureFingerprint(block)
      if (!fingerprint) continue
      const counts = failuresByTool.get(toolName) ?? new Map()
      counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1)
      failuresByTool.set(toolName, counts)
    }
  }
  const failedTools = new Set()
  let maxFailures = 0
  for (const [toolName, counts] of failuresByTool) {
    for (const [fingerprint, count] of counts) {
      const effectiveThreshold = fingerprint.includes('external web fallback through powershell is disabled') ? 1 : threshold
      if (count >= effectiveThreshold) failedTools.add(toolName)
      maxFailures = Math.max(maxFailures, count)
    }
  }
  return { failedTools, maxFailures, guidance: [...guidanceByTool.values()] }
}

function failedGeminiWebSearchInTurn(messages, turnStart = 0) {
  const searchCallIds = new Set()
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.name === GEMINI_WEB_SEARCH_TOOL && block.id) {
        searchCallIds.add(block.id)
        continue
      }
      if (block.type !== 'tool-result' || !block.isError) continue
      if (searchCallIds.has(block.toolCallId ?? block.id)) return true
    }
  }
  return false
}

const SEARCH_QUERY_NOISE = new Set(['http', 'https', 'www', 'site', 'com'])

function searchQueryTokens(query) {
  return new Set((String(query ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => !SEARCH_QUERY_NOISE.has(token)))
}

function searchQueryDomains(query) {
  const value = String(query ?? '').toLowerCase()
  const domains = new Set()
  for (const match of value.matchAll(/(?:https?:\/\/|site:)(?:www\.)?([^\s/"']+)/g)) {
    if (match[1]) domains.add(match[1].replace(/[),.;]+$/, ''))
  }
  return domains
}

function nearEquivalentSearchQuery(left, right, userRequest = '') {
  const leftTokens = searchQueryTokens(left)
  const rightTokens = searchQueryTokens(right)
  if (!leftTokens.size || !rightTokens.size) return false
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length
  if (intersection < 2) return false
  const leftDomains = searchQueryDomains(left)
  const rightDomains = searchQueryDomains(right)
  const sameExplicitDomain = [...leftDomains].some((domain) => rightDomains.has(domain))
  if (sameExplicitDomain && (/https?:\/\//i.test(left) || /https?:\/\//i.test(right))) {
    const requestTokens = searchQueryTokens(userRequest)
    const topicalOverlap = [...rightTokens].filter((token) => requestTokens.has(token)).length
    if (topicalOverlap >= 2) return true
  }
  const containment = intersection / Math.min(leftTokens.size, rightTokens.size)
  const union = new Set([...leftTokens, ...rightTokens]).size
  return containment >= 0.75 || intersection / union >= 0.65
}

function redundantSearchState(messages, turnStart) {
  const searches = []
  const byCallId = new Map()
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.name === GEMINI_WEB_SEARCH_TOOL) {
        let args = block.arguments
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = {} }
        }
        const entry = { callId: block.id, query: args?.query ?? '', result: '' }
        searches.push(entry)
        if (block.id) byCallId.set(block.id, entry)
      } else if (block.type === 'tool-result' && !block.isError) {
        const entry = byCallId.get(block.toolCallId ?? block.id)
        if (entry) entry.result = toolResultText(block)
      }
    }
  }
  const successful = searches.filter((entry) => entry.result.length >= 40)
  if (successful.length < 2) return { shouldConverge: false }
  const latest = successful.at(-1)
  const userRequest = (messages?.[turnStart]?.content ?? [])
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map((block) => block.text)
    .join(' ')
  const previous = successful.slice(0, -1)
    .findLast((entry) => nearEquivalentSearchQuery(entry.query, latest.query, userRequest))
  return previous
    ? { shouldConverge: true, previousQuery: previous.query, latestQuery: latest.query }
    : { shouldConverge: false }
}

function pendingResearchVerification(messages, turnStart) {
  const callNames = new Map()
  for (const message of messages ?? []) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.id && block.name) callNames.set(block.id, block.name)
    }
  }
  let order = 0
  let latestSearch = -1
  let latestVerification = -1
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      order += 1
      if (block.type === 'tool-call') continue
      if (block.type !== 'tool-result' || block.isError) continue
      const toolName = block.name ?? block.toolName ?? callNames.get(block.toolCallId ?? block.id)
      if (toolName === GEMINI_WEB_SEARCH_TOOL && toolResultText(block).length >= 40) latestSearch = order
      if (toolName === GEMINI_VERIFY_CLAIMS_TOOL && toolResultText(block).length >= 40) latestVerification = order
    }
  }
  return latestSearch >= 0 && latestSearch > latestVerification
}

function pendingWrittenDraftVerification(messages, turnStart, userText) {
  if (!/(?:核查|核实|事实|来源|链接|引用|研究|报告|新闻|最新|verify|fact.?check|citation|source|research|report)/iu.test(userText)) return false
  const calls = new Map()
  const draftPaths = new Set()
  const draftBasenames = new Set()
  let order = 0
  let latestDraft = -1
  let latestVerification = -1
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      order += 1
      if (block.type === 'tool-call' && block.id && block.name) {
        let args = block.arguments
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = {} }
        }
        calls.set(block.id, { name: String(block.name).toLowerCase(), args: args ?? {} })
        continue
      }
      if (block.type !== 'tool-result' || block.isError) continue
      const call = calls.get(block.toolCallId ?? block.id)
      if (!call) continue
      if (call.name === GEMINI_VERIFY_CLAIMS_TOOL && toolResultText(block).length >= 40) {
        latestVerification = order
        continue
      }
      if (!['write', 'edit'].includes(call.name)) continue
      const body = call.name === 'write' ? call.args.content : call.args.new_string
      const path = String(call.args.file_path ?? call.args.path ?? '').replace(/\\/g, '/').toLowerCase()
      const basename = path.split('/').at(-1) ?? ''
      if (typeof body !== 'string') continue
      if (/(?:事实核查|核查表|fact.?check)/iu.test(`${path}\n${body.slice(0, 500)}`)) continue
      const knownDraft = draftPaths.has(path) || (basename && draftBasenames.has(basename))
      if (!knownDraft) {
        if (body.length < 1_500) continue
        if (!/\.(?:md|markdown|txt)$/iu.test(path) && !/(?:研究|报告|分析|research|report)/iu.test(body.slice(0, 1_000))) continue
        draftPaths.add(path)
        if (basename) draftBasenames.add(basename)
      }
      latestDraft = order
    }
  }
  return latestDraft >= 0 && latestDraft > latestVerification
}

function parsedToolArguments(block) {
  if (!block || block.type !== 'tool-call') return {}
  if (block.arguments && typeof block.arguments === 'object') return block.arguments
  try { return JSON.parse(block.arguments || '{}') } catch { return {} }
}

export function researchArtifactState(messages, turnStart = 0) {
  const calls = new Map()
  const draftPaths = new Set()
  const factCheckPaths = new Set()
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.id && block.name) {
        calls.set(block.id, { name: String(block.name).toLowerCase(), args: parsedToolArguments(block) })
        continue
      }
      if (block.type !== 'tool-result' || block.isError) continue
      const call = calls.get(block.toolCallId ?? block.id)
      if (!call || !['write', 'edit'].includes(call.name)) continue
      const path = String(call.args.file_path ?? call.args.path ?? '').replace(/\\/g, '/')
      const body = call.name === 'write' ? call.args.content : call.args.new_string
      if (!path || typeof body !== 'string') continue
      const factCheck = /(?:fact[-_ ]?check|事实核查|核查表)/iu.test(path)
        || (/(?:^|\n)#{1,4}\s*(?:事实核查|核查表|fact[-_ ]?check)/imu.test(body) && /\|[^\n]+\|/u.test(body))
      if (factCheck) {
        factCheckPaths.add(path)
        continue
      }
      if (body.length >= 1_500 && (/\.(?:md|markdown|txt)$/iu.test(path) || /(?:研究|报告|分析|research|report)/iu.test(body.slice(0, 1_000)))) {
        draftPaths.add(path)
      }
    }
  }
  return {
    hasLongDraft: draftPaths.size > 0,
    hasFactCheckArtifact: factCheckPaths.size > 0,
    draftPaths: [...draftPaths],
    factCheckPaths: [...factCheckPaths],
  }
}

function researchCompletionState(messages, turnStart = 0) {
  const calls = new Map()
  for (const message of (messages ?? []).slice(turnStart + 1)) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.id && block.name) {
        calls.set(block.id, { name: String(block.name).toLowerCase(), args: parsedToolArguments(block) })
        continue
      }
      if (block.type !== 'tool-result' || block.isError) continue
      const call = calls.get(block.toolCallId ?? block.id)
      if (call?.name === 'update_goal' && call.args.action === 'complete') return true
      if (call && /(?:todo|task).*(?:write|update)|(?:write|update).*(?:todo|task)/iu.test(call.name)) {
        const todos = call.args.todos ?? call.args.tasks ?? call.args.items
        if (Array.isArray(todos) && todos.length && todos.every((item) => item?.status === 'completed')) return true
      }
    }
  }
  return false
}

function artifactPathsInText(text) {
  return [...String(text ?? '').matchAll(/`([^`\r\n]+\.(?:docx|md|markdown|txt))`/giu)].map((match) => match[1])
}

export function compactResearchFinalText(text, context = {}) {
  const original = String(text ?? '')
  const artifacts = context.artifacts ?? { draftPaths: [], factCheckPaths: [] }
  if (!artifacts.hasLongDraft || original.length < 1_500) return original
  const paths = [...new Set([
    ...(artifacts.draftPaths ?? []),
    ...(artifacts.factCheckPaths ?? []),
    ...artifactPathsInText(original),
  ])]
  const docx = paths.filter((path) => /\.docx$/iu.test(path))
  const markdown = paths.filter((path) => /\.(?:md|markdown|txt)$/iu.test(path) && !(artifacts.factCheckPaths ?? []).includes(path))
  const factChecks = [...new Set(artifacts.factCheckPaths ?? [])]
  const lines = []
  if (context.verificationPending) {
    lines.push('研究报告文件已经生成，但最新正文改动或检索结果尚未完成严格复核，因此本次交付不能标记为完整完成。')
  } else if (!artifacts.hasFactCheckArtifact) {
    lines.push('研究报告文件已经生成，但独立事实核查表尚未成功写入文件，因此本次交付不能标记为完整完成。')
  } else {
    lines.push('研究任务已完成，正文和独立事实核查表均已写入文件。')
  }
  const appendPaths = (label, values) => {
    for (const path of values) lines.push(`- ${label}：\`${path}\``)
  }
  appendPaths('Word 报告', docx)
  appendPaths('Markdown 正文', markdown)
  appendPaths('事实核查表', factChecks)
  const counts = (context.verifications ?? []).reduce((result, item) => {
    const status = String(item.status ?? 'UNVERIFIED').toUpperCase()
    result[status] = (result[status] ?? 0) + 1
    return result
  }, {})
  if (Object.keys(counts).length) {
    lines.push(`严格核查状态：${Object.entries(counts).map(([status, count]) => `${status} ${count} 条`).join('，')}。PARTIAL、UNSUPPORTED、CONFLICTING 或 UNREACHABLE 项不得标成已核。`)
  }
  lines.push('为避免长上下文串线，聊天中不再重复粘贴整篇正文或完整核查表。')
  return lines.join('\n\n')
}

export function prepareSearchConvergence(options = {}, maxCalls = 6, now = new Date()) {
  const tools = options.tools ?? []
  const hasLegacyWebTools = tools.some((tool) => ['web_search', 'web_fetch'].includes(tool.name))
  const hasGeminiWebSearch = tools.some((tool) => tool.name === GEMINI_WEB_SEARCH_TOOL)
  let turnStart = 0
  for (let index = options.messages?.length - 1; index >= 0; index -= 1) {
    if (isHumanUserMessage(options.messages[index])) { turnStart = index; break }
  }
  const used = (options.messages ?? []).slice(turnStart + 1).reduce((count, message) => count + (message.content ?? []).filter((block) => block.type === 'tool-call' && block.name === GEMINI_WEB_SEARCH_TOOL).length, 0)
  const budget = Number.isInteger(maxCalls) && maxCalls > 0 ? maxCalls : 6
  const exhausted = used >= budget
  const duplicateTool = trailingDuplicateTool(options.messages, turnStart)
  const emptyDiscovery = emptyDiscoveryState(options.messages, turnStart)
  const redundantSearch = redundantSearchState(options.messages, turnStart)
  const recovery = toolFailureRecoveryState(options.messages, turnStart)
  if (!hasLegacyWebTools && !hasGeminiWebSearch && !duplicateTool && !emptyDiscovery.shouldConverge && !recovery.failedTools.size && !recovery.guidance.length) return options
  const dateAnchor = runtimeDateAnchor(now)
  const userText = (options.messages?.[turnStart]?.content ?? [])
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map((block) => block.text)
    .join(' ')
  const verificationAvailable = tools.some((tool) => tool.name === GEMINI_VERIFY_CLAIMS_TOOL)
  const hasResearchWorkflow = (options.messages ?? []).slice(turnStart + 1).some((message) => (message.content ?? []).some((block) =>
    block.type === 'tool-call' && [GEMINI_WEB_SEARCH_TOOL, GEMINI_VERIFY_CLAIMS_TOOL].includes(block.name),
  ))
  const researchLike = hasResearchWorkflow || /(?:核查|核实|事实|来源|链接|引用|研究|报告|新闻|最新|verify|fact.?check|citation|source|research|report)/iu.test(userText)
  const searchVerificationPending = verificationAvailable && researchLike && pendingResearchVerification(options.messages, turnStart)
  const draftVerificationPending = verificationAvailable && researchLike && pendingWrittenDraftVerification(options.messages, turnStart, userText)
  const verificationPending = searchVerificationPending || draftVerificationPending
  const artifacts = researchArtifactState(options.messages, turnStart)
  const priorVerifications = collectPriorClaimVerifications(options.messages)
  const factCheckArtifactPending = verificationAvailable
    && researchLike
    && priorVerifications.length > 0
    && artifacts.hasLongDraft
    && !artifacts.hasFactCheckArtifact
  const timeConstraints = relativeTimeConstraints(userText)
  const rollingWindow = requestedRollingWindow(timeConstraints, now)
  const rollingWindowGuidance = rollingWindow
    ? ` Exact requested rolling window for "${rollingWindow.constraint}": ${runtimeDateAnchor(rollingWindow.start)} through ${runtimeDateAnchor(rollingWindow.end)}.`
    : ''
  let guidance = hasLegacyWebTools || hasGeminiWebSearch
    ? `${SEARCH_CONVERGENCE_POLICY}\n- Runtime date anchor for this request: ${dateAnchor}.${rollingWindowGuidance}`
    : ''
  if (hasGeminiWebSearch && exhausted) {
    guidance += '\n- The Gemini native web lookup budget for this user turn is exhausted. Answer from existing web evidence or continue with relevant non-network tools.'
  }
  if (duplicateTool) {
    guidance += `\n- The latest ${duplicateTool} operation exactly duplicates the preceding call. It is temporarily unavailable: use its existing result or make progress with a different tool. It becomes available again after another tool changes or inspects relevant state.`
  }
  if (emptyDiscovery.shouldConverge) {
    guidance += `\n- ${emptyDiscovery.count} distinct local discovery operations in this turn returned empty results and no operation produced usable evidence. Do not call another tool now. Ask the user for the missing workspace, path, or identifier.`
  }
  if (redundantSearch.shouldConverge) {
    guidance += '\n- Two successful Gemini web lookups used near-equivalent queries and already produced substantive evidence. Gemini web lookup is now unavailable for this turn: answer from those results instead of rephrasing the same search again.'
  }
  if (recovery.guidance.length) {
    guidance += `\n- Tool recovery instructions:\n${recovery.guidance.map((item) => `  - ${item}`).join('\n')}`
  }
  if (recovery.failedTools.size) {
    guidance += `\n- The following tools repeatedly produced equivalent failures and are temporarily unavailable for this turn: ${[...recovery.failedTools].join(', ')}. Do not rephrase and retry the same failing operation. Continue with a different relevant tool, or explain the blocker if no safe alternative exists.`
  }
  if (verificationPending) {
    guidance += draftVerificationPending
      ? `\n- A long research draft was written after the latest successful ${GEMINI_VERIFY_CLAIMS_TOOL} result. Before any further write or edit, extract the complete inventory of material claims actually present in that draft (including every consequential date, quantity, institution, named case, policy, specification, action, and outcome) and call ${GEMINI_VERIFY_CLAIMS_TOOL} with their exact prior grounded URLs. Do not use a representative sample. Revise or qualify every non-VERIFIED outcome before finalizing the deliverable or its fact-check table. Write and edit tools are temporarily unavailable until this post-draft verification succeeds.`
      : `\n- A successful grounded lookup is newer than the latest successful ${GEMINI_VERIFY_CLAIMS_TOOL} result. Before writing, editing, or presenting material research claims as verified, call ${GEMINI_VERIFY_CLAIMS_TOOL} for the consequential claims using exact URLs from that newest evidence. Write and edit tools are temporarily unavailable until this verification succeeds.`
  }
  if (factCheckArtifactPending) {
    guidance += `\n- A long research deliverable and structured claim-verification results exist, but no separate fact-check artifact has been written successfully. Before marking the goal or task list complete, use the write tool to create a separate Markdown fact-check table. Include every submitted V-number, preserve its exact VERIFIED/PARTIAL/UNSUPPORTED/CONFLICTING/UNREACHABLE status and exact verified source URL, and do not paste the full table into the final chat response.`
  }
  return {
    ...options,
    system: [options.system, guidance].filter(Boolean).join('\n\n'),
    tools: tools
      .filter((tool) => !['web_search', 'web_fetch'].includes(tool.name))
      .filter(() => !emptyDiscovery.shouldConverge)
      .filter((tool) => !(exhausted && tool.name === GEMINI_WEB_SEARCH_TOOL))
      .filter((tool) => !(redundantSearch.shouldConverge && tool.name === GEMINI_WEB_SEARCH_TOOL))
      .filter((tool) => tool.name !== duplicateTool)
      .filter((tool) => !recovery.failedTools.has(tool.name))
      .filter((tool) => !(verificationPending && ['write', 'edit'].includes(String(tool.name ?? '').toLowerCase())))
      .filter((tool) => !(factCheckArtifactPending && String(tool.name ?? '').toLowerCase() === 'update_goal'))
      .map((tool) => tool.name === GEMINI_WEB_SEARCH_TOOL
        ? { ...tool, description: `${tool.description ?? 'Search with Gemini native web tools.'} Runtime date: ${dateAnchor}.${rollingWindowGuidance} Resolve relative time in the user's request before forming the query, preserve that time constraint across retries, and avoid duplicate or near-duplicate queries.` }
        : tool),
  }
}

async function runNativeWebLookupOnce(config, query, signal, model, lookupMode = 'search') {
  const normalizedQuery = typeof query === 'string' ? query.trim() : ''
  if (!normalizedQuery) {
    const error = new Error(`${GEMINI_WEB_SEARCH_TOOL} requires a non-empty query`)
    error.code = 'INVALID_ARGS'
    throw error
  }
  const keyName = configValue(config, 'apiKeyEnv', 'AISTUDIO_API_KEY')
  const key = usableApiKey(await config.resolveApiKey?.(false), keyName)
  const hasExplicitUrl = /https?:\/\/[^\s<>()]+/i.test(normalizedQuery)
  const verificationOnly = lookupMode === 'verification'
  const nativeTools = verificationOnly
    ? [{ urlContext: {} }]
    : hasExplicitUrl ? [{ googleSearch: {} }, { urlContext: {} }] : [{ googleSearch: {} }]
  const instruction = verificationOnly
    ? `Actually retrieve every supplied exact URL with URL Context. Do not use Google Search, substitute another page, construct a URL, or answer from memory. For every numbered claim report VERIFIED, PARTIAL, UNSUPPORTED, CONFLICTING, or UNREACHABLE. VERIFIED requires the retrieved page to directly support the claim's subject, date, quantity, attribution, and status. State the precise supported scope and every material mismatch. Runtime date anchor: ${runtimeDateAnchor()}.`
    : `You must actually invoke Google Search for this lookup; do not answer from model memory or internal knowledge alone. Use URL Context as well when the request contains an explicit URL. Runtime date anchor: ${runtimeDateAnchor()}. Resolve every relative time expression against that date and state the absolute date range used. Verify the exact target and return only claims directly supported by the retrieved pages. Preserve whether evidence is an official statement, attributed analysis, channel check, rumor, or inference. Never merge separate sources into a relationship or company action that no source explicitly states. Copy source URLs exactly from grounding results; never construct, concatenate, or repair a URL. Distinguish verified facts from partial, conflicting, or unsupported leads, and map each material claim to the source that directly supports it.`
  const response = await fetch(`${String(config.baseURL).replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${instruction}\n\n${normalizedQuery}` }] }],
      tools: nativeTools,
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
    }),
    signal,
  })
  if (!response.ok) throw responseFailure(`Gemini native web lookup returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`, response.status)
  const payload = await response.json()
  const text = (payload.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim()
  if (!text) throw responseFailure('Gemini native web lookup returned no grounded text', 502)
  const maxOutputChars = configValue(config, 'searchMaxOutputChars', 30_000)
  const sources = []
  const supports = []
  const seenSources = new Set()
  const addSource = (rawUri, rawTitle, kind) => {
    const uri = typeof rawUri === 'string' ? rawUri.trim() : ''
    if (!/^https?:\/\//i.test(uri) || seenSources.has(uri)) return
    seenSources.add(uri)
    sources.push({ uri, title: typeof rawTitle === 'string' ? rawTitle.trim() : '', kind })
  }
  for (const candidate of payload.candidates ?? []) {
    for (const metadata of candidate.urlContextMetadata?.urlMetadata ?? []) {
      addSource(metadata.retrievedUrl, metadata.title, 'url_context')
    }
    const groundingChunks = candidate.groundingMetadata?.groundingChunks ?? []
    for (const chunk of groundingChunks) {
      addSource(chunk.web?.uri, chunk.web?.title, 'google_search')
    }
    for (const support of candidate.groundingMetadata?.groundingSupports ?? []) {
      const claim = typeof support.segment?.text === 'string' ? support.segment.text.trim() : ''
      const sourceUris = [...new Set((support.groundingChunkIndices ?? [])
        .map((index) => groundingChunks[index]?.web?.uri)
        .filter((uri) => typeof uri === 'string' && /^https?:\/\//i.test(uri)))]
      if (claim && sourceUris.length) supports.push({ claim, sourceUris })
    }
  }
  if (!sources.length && verificationOnly) {
    for (const [index, uri] of [...new Set(urlsInText(normalizedQuery))].entries()) {
      addSource(uri, `Supplied verification source ${index + 1}`, 'url_context')
    }
  }
  if (!sources.length) {
    throw responseFailure('Gemini native web lookup returned text without grounding source URLs; refusing to treat ungrounded model text as web evidence', 502)
  }
  return {
    text: text.slice(0, maxOutputChars),
    sources,
    supports,
    model,
    query: normalizedQuery,
    googleSearch: !verificationOnly,
    urlContext: verificationOnly || hasExplicitUrl,
  }
}

export async function runNativeWebLookup(config, query, signal, selectedModel, lookupMode = 'search') {
  const inheritedModel = typeof selectedModel === 'string' && selectedModel.trim()
    ? selectedModel.trim()
    : undefined
  const preferredModel = configValue(config, 'searchModel', undefined)
    || inheritedModel
    || config.models?.[0]
    || 'gemini-3.7-flash'
  const fallbackModel = configValue(config, 'searchFallbackModel', undefined)
  const models = [...new Set([preferredModel, fallbackModel].filter((model) => typeof model === 'string' && model.trim()))]
  let lastError
  for (const [index, model] of models.entries()) {
    try {
      return await runNativeWebLookupOnce(config, query, signal, model, lookupMode)
    } catch (error) {
      lastError = error
      const mayFallback = error?.code !== 'INVALID_ARGS'
        && (error?.code === 'RATE_LIMIT' || Number(error?.status) >= 500 || /without grounding source URLs|returned no grounded text/i.test(error?.message ?? ''))
      if (!mayFallback || index === models.length - 1) throw error
    }
  }
  throw lastError ?? responseFailure('Gemini native web lookup has no configured search model', 500)
}

function evidencePacket(value, heading = 'Grounded evidence packet') {
  const sources = Array.isArray(value?.sources) ? value.sources : []
  const supports = Array.isArray(value?.supports) ? value.supports : []
  if (!sources.length && !supports.length) return String(value?.text ?? '').slice(0, 6000)
  const sourceIds = new Map(sources.map((source, index) => [source.uri, `S${index + 1}`]))
  const exactUrls = sources.map((source, index) => {
    const label = source.title ? ` — ${source.title}` : ''
    return `[S${index + 1}] ${source.uri}${label} [${source.kind}]`
  }).join('\n')
  const supportMap = supports.slice(0, 80).map((support, index) => {
    const ids = support.sourceUris.map((uri) => sourceIds.get(uri)).filter(Boolean)
    return `[C${index + 1}] ${String(support.claim ?? '').slice(0, 1200)}\n  Sources: ${ids.join(', ') || 'none'}`
  }).join('\n')
  const fallback = supports.length ? '' : `\nProvider synthesis (not independently verified beyond the listed sources):\n${String(value?.text ?? '').slice(0, 6000)}`
  return `${heading}\n\nSources (citation whitelist; copy URLs exactly):\n${exactUrls}${supportMap ? `\n\nDirectly supported claims:\n${supportMap}` : ''}${fallback}\n\nEvidence rules: cite only an exact URL listed above; do not construct or repair URLs. A claim not represented in the supported-claims section is not verified by this packet.`
}

export function renderNativeWebLookup(value) {
  const requestedWindow = String(value?.query ?? '').match(/Exact requested rolling window[^:]*:\s*([^.]*)\./i)?.[1]?.trim()
  const temporalGate = requestedWindow
    ? `Temporal acceptance gate for the final answer: ${requestedWindow}. An event is responsive only when its actual event date or publication date, as directly supported by the cited page, falls inside this range. Omit every out-of-window item even if it ranks highly or the lookup prose labels it recent. If fewer requested items survive, report that honestly instead of filling the gap with older material.`
    : ''
  return [{
    type: 'text',
    text: `${temporalGate ? `${temporalGate}\n\n` : ''}${evidencePacket(value)}`,
  }]
}

function normalizeVerificationClaims(claims) {
  if (!Array.isArray(claims) || !claims.length) {
    const error = new Error(`${GEMINI_VERIFY_CLAIMS_TOOL} requires at least one claim`)
    error.code = 'INVALID_ARGS'
    throw error
  }
  const normalized = claims.slice(0, 48).map((item, index) => ({
    id: `V${index + 1}`,
    claim: typeof item?.claim === 'string' ? item.claim.trim() : '',
    sourceUrls: [...new Set((Array.isArray(item?.sourceUrls) ? item.sourceUrls : [])
      .filter((uri) => typeof uri === 'string' && /^https?:\/\//i.test(uri.trim()))
      .map((uri) => uri.trim()))],
  }))
  if (normalized.some((item) => !item.claim || !item.sourceUrls.length)) {
    const error = new Error(`${GEMINI_VERIFY_CLAIMS_TOOL} requires every claim to have text and at least one exact source URL`)
    error.code = 'INVALID_ARGS'
    throw error
  }
  return normalized
}

const GROUNDING_REDIRECT_PREFIX = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'

function stripStreamedJsonAfterGroundingToken(uri) {
  if (!uri.startsWith(GROUNDING_REDIRECT_PREFIX)) return uri
  const token = uri.slice(GROUNDING_REDIRECT_PREFIX.length)
  const valid = token.match(/^[A-Za-z0-9_-]+={0,2}/)?.[0]
  return valid && valid.length >= 32 ? `${GROUNDING_REDIRECT_PREFIX}${valid}` : uri
}

function editDistanceAtMost(left, right, maximum = 2) {
  if (Math.abs(left.length - right.length) > maximum) return false
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = current[0]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      rowMinimum = Math.min(rowMinimum, current[rightIndex])
    }
    if (rowMinimum > maximum) return false
    previous = current
  }
  return previous[right.length] <= maximum
}

function repairUniqueGroundingRedirectTypo(uri, allowed) {
  if (!uri.startsWith(GROUNDING_REDIRECT_PREFIX)) return uri
  const token = uri.slice(GROUNDING_REDIRECT_PREFIX.length)
  if (token.length < 32) return uri
  const candidates = [...allowed].filter((candidate) => {
    if (!candidate.startsWith(GROUNDING_REDIRECT_PREFIX)) return false
    return editDistanceAtMost(token, candidate.slice(GROUNDING_REDIRECT_PREFIX.length), 2)
  })
  return candidates.length === 1 ? candidates[0] : uri
}

function verificationClaimBatches(claims, maxClaims = 4, maxUrls = 6) {
  const batches = []
  let current = []
  let currentUrls = new Set()
  for (const claim of claims) {
    const nextUrls = new Set([...currentUrls, ...claim.sourceUrls])
    if (current.length && (current.length >= maxClaims || nextUrls.size > maxUrls)) {
      batches.push(current)
      current = []
      currentUrls = new Set()
    }
    current.push(claim)
    for (const uri of claim.sourceUrls) currentUrls.add(uri)
  }
  if (current.length) batches.push(current)
  return batches
}

function verificationQuery(claims) {
  return [
    'Verify each numbered claim only against its supplied exact source URLs. Actually retrieve every supplied URL with URL Context. For each claim, report one of VERIFIED, PARTIAL, UNSUPPORTED, CONFLICTING, or UNREACHABLE, followed by the exact supported scope and any mismatch in subject, date, quantity, attribution, or status. Do not search for replacement evidence and do not repair URLs.',
    ...claims.map((item) => `${item.id}. Claim: ${item.claim}\nSources:\n${item.sourceUrls.join('\n')}`),
  ].join('\n\n')
}

function verificationOutcomes(claims, text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const ids = claims.map((item) => item.id)
  const lineMentionsId = (line, id) => {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^A-Za-z0-9_])${escapedId}(?:[^A-Za-z0-9_]|$)`, 'i').test(line)
  }
  const outcomes = claims.map((item) => {
    const start = lines.findIndex((line) => lineMentionsId(line, item.id))
    if (start < 0) return { ...item, status: undefined, details: '' }
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (ids.some((id) => id !== item.id && lineMentionsId(lines[index], id))) {
        end = index
        break
      }
    }
    const segment = lines.slice(start, Math.min(end, start + 8)).join('\n').trim()
    const status = segment.match(/\b(VERIFIED|PARTIAL|UNSUPPORTED|CONFLICTING|UNREACHABLE)\b/i)?.[1]?.toUpperCase()
    return { ...item, status, details: segment }
  })
  const incomplete = outcomes.find((item) => !item.status)
  if (incomplete) {
    throw responseFailure(`${GEMINI_VERIFY_CLAIMS_TOOL} returned no explicit per-claim status for ${incomplete.id}; refusing to treat the lookup as verification`, 502)
  }
  return outcomes
}

export async function runNativeClaimVerification(config, claims, allowedSources, signal, selectedModel) {
  const allowed = new Set((allowedSources ?? []).map((source) => source.uri))
  const normalized = normalizeVerificationClaims(claims).map((item) => ({
    ...item,
    sourceUrls: item.sourceUrls.map((rawUri) => {
      const uri = stripStreamedJsonAfterGroundingToken(rawUri)
      return allowed.has(uri) ? uri : repairUniqueGroundingRedirectTypo(uri, allowed)
    }),
  }))
  const unknown = normalized.flatMap((item) => item.sourceUrls).filter((uri) => !allowed.has(uri))
  if (unknown.length) {
    const error = new Error(`${GEMINI_VERIFY_CLAIMS_TOOL} accepts only exact URLs returned by prior grounded lookups; unknown URL: ${unknown[0]}`)
    error.code = 'INVALID_ARGS'
    throw error
  }
  const results = []
  const verifications = []
  for (const batch of verificationClaimBatches(normalized)) {
    const query = verificationQuery(batch)
    const result = await runNativeWebLookup(config, query, signal, selectedModel, 'verification')
    verifications.push(...verificationOutcomes(batch, result.text))
    results.push(result)
  }
  const sources = []
  const supports = []
  const seenSources = new Set()
  for (const result of results) {
    for (const source of result.sources ?? []) {
      if (!source?.uri || seenSources.has(source.uri)) continue
      seenSources.add(source.uri)
      sources.push(source)
    }
    supports.push(...(result.supports ?? []))
  }
  return {
    text: results.length === 1
      ? results[0].text
      : results.map((result, index) => `Batch ${index + 1}:\n${result.text}`).join('\n\n'),
    sources,
    supports,
    model: results.at(-1)?.model ?? selectedModel ?? '',
    query: results.map((result) => result.query).join('\n\n--- verification batch ---\n\n'),
    googleSearch: false,
    urlContext: true,
    requestedClaims: normalized,
    verifications,
  }
}

function renderClaimVerification(value) {
  const sources = Array.isArray(value?.sources) ? value.sources : []
  const sourceIds = new Map(sources.map((source, index) => [source.uri, `S${index + 1}`]))
  const sourceLines = sources.map((source, index) => `[S${index + 1}] ${source.uri}${source.title ? ` — ${source.title}` : ''} [${source.kind}]`).join('\n')
  const outcomes = (value?.verifications ?? []).map((item) => {
    const ids = item.sourceUrls.map((uri) => sourceIds.get(uri)).filter(Boolean)
    return `[${item.id}] ${item.status}: ${item.claim}\n  Sources: ${ids.join(', ') || 'none'}${item.details ? `\n  Provider: ${item.details}` : ''}`
  }).join('\n')
  return `Claim verification evidence packet\n\nSources (citation whitelist; copy URLs exactly):\n${sourceLines}\n\nVerification outcomes:\n${outcomes}\n\nEvidence rules: only VERIFIED claims may be labeled verified. PARTIAL claims must be narrowed to the supported scope. UNSUPPORTED, CONFLICTING, and UNREACHABLE claims must not be presented as verified. Every verified fact-check row must include its exact source URL from the whitelist above.`
}

function cachedGroundedSources(cache, exec) {
  const key = exec?.agent
  if (!key || (typeof key !== 'object' && typeof key !== 'function')) return []
  return cache.get(key) ?? []
}

function rememberGroundedSources(cache, exec, sources) {
  const key = exec?.agent
  if (!key || (typeof key !== 'object' && typeof key !== 'function')) return
  const merged = []
  const seen = new Set()
  for (const source of [...cachedGroundedSources(cache, exec), ...(sources ?? [])]) {
    const uri = typeof source?.uri === 'string' ? source.uri.trim() : ''
    if (!uri || seen.has(uri)) continue
    seen.add(uri)
    merged.push({ uri, title: typeof source?.title === 'string' ? source.title : '' })
  }
  cache.set(key, merged)
}

function mergedGroundedSources(...groups) {
  const merged = []
  const seen = new Set()
  for (const source of groups.flat()) {
    const uri = typeof source?.uri === 'string' ? source.uri.trim() : ''
    if (!uri || seen.has(uri)) continue
    seen.add(uri)
    merged.push({ uri, title: typeof source?.title === 'string' ? source.title : '' })
  }
  return merged
}

function registerNativeClaimVerificationTool(ctx, config, sourceCache) {
  return ctx.tools.register({
    name: GEMINI_VERIFY_CLAIMS_TOOL,
    description: 'Re-open exact URLs from prior grounded Gemini searches and verify the complete inventory of material claims before labeling them verified or writing a fact-check table. Include all consequential cases, dates, quantities, institutions, policies, specifications, actions, and outcomes from the intended deliverable rather than a representative sample; the adapter batches large inventories internally.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          minItems: 1,
          maxItems: 48,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claim', 'sourceUrls'],
            properties: {
              claim: { type: 'string', description: 'One atomic externally checkable claim. Split claims when their subject, date, quantity, action, outcome, or supporting URLs differ.' },
              sourceUrls: { type: 'array', minItems: 1, items: { type: 'string' } },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sources', 'supports', 'model', 'query', 'googleSearch', 'urlContext', 'requestedClaims', 'verifications'],
        properties: {
          text: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['uri', 'title', 'kind'],
              properties: {
                uri: { type: 'string' },
                title: { type: 'string' },
                kind: { type: 'string', enum: ['google_search', 'url_context'] },
              },
            },
          },
          supports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'sourceUris'],
              properties: {
                claim: { type: 'string' },
                sourceUris: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          model: { type: 'string' },
          query: { type: 'string' },
          googleSearch: { type: 'boolean' },
          urlContext: { type: 'boolean' },
          requestedClaims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'claim', 'sourceUrls'],
              properties: {
                id: { type: 'string' },
                claim: { type: 'string' },
                sourceUrls: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          verifications: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'claim', 'sourceUrls', 'status', 'details'],
              properties: {
                id: { type: 'string' },
                claim: { type: 'string' },
                sourceUrls: { type: 'array', items: { type: 'string' } },
                status: { type: 'string', enum: ['VERIFIED', 'PARTIAL', 'UNSUPPORTED', 'CONFLICTING', 'UNREACHABLE'] },
                details: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderClaimVerification(value) }],
    },
    // Verification may fan out into several small URL Context batches.  The
    // outer dsh deadline must cover the complete inventory, not just one batch.
    timeoutMs: GEMINI_VERIFY_CLAIMS_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: (args, exec) => runNativeClaimVerification(
      config,
      args.claims,
      mergedGroundedSources(
        cachedGroundedSources(sourceCache, exec),
        collectPriorSearchSources(exec.agent?.options?.messages),
      ),
      exec.signal,
      exec.agent?.options?.model,
    ),
    presentCall: (args) => ({ card: 'generic', title: `核验 ${args.claims?.length ?? 0} 条事实`, kind: 'search' }),
  })
}

function registerNativeWebSearchTool(ctx, config, sourceCache) {
  return ctx.tools.register({
    name: GEMINI_WEB_SEARCH_TOOL,
    description: 'Search the public web with Gemini native Google Search and read explicit public URLs with Gemini URL Context. Use this for all web research, current information, exact GitHub repositories, package versions, DOI/CVE identifiers, quoted errors, webpages, public images, and public PDFs. Include complete URLs or exact identifiers in one precise query.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'One precise web lookup request. Include complete URLs and exact identifiers when available.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sources', 'supports', 'model', 'query', 'googleSearch', 'urlContext'],
        properties: {
          text: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['uri', 'title', 'kind'],
              properties: {
                uri: { type: 'string' },
                title: { type: 'string' },
                kind: { type: 'string', enum: ['google_search', 'url_context'] },
              },
            },
          },
          supports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'sourceUris'],
              properties: {
                claim: { type: 'string' },
                sourceUris: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          model: { type: 'string' },
          query: { type: 'string' },
          googleSearch: { type: 'boolean' },
          urlContext: { type: 'boolean' },
        },
      },
      render: (_args, value) => renderNativeWebLookup(value),
    },
    // Native grounding can occasionally take slightly more than two minutes.
    // Keep a finite deadline while avoiding a premature dsh-side cancellation.
    timeoutMs: GEMINI_WEB_SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const result = await runNativeWebLookup(
        config,
        args.query,
        exec.signal,
        exec.agent?.options?.model,
      )
      rememberGroundedSources(sourceCache, exec, result.sources)
      return result
    },
    presentCall: (args) => ({ card: 'generic', title: args.query, kind: 'search', rawInput: args.query }),
  })
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
    const requestOptions = prepareAgentExecution(prepareSearchConvergence(options, this.config.searchMaxCallsPerTurn))
    const toolParameters = new Map((requestOptions.tools ?? []).map((tool) => [tool.name, tool.parameters]))
    let turnStart = 0
    for (let index = requestOptions.messages?.length - 1; index >= 0; index -= 1) {
      if (isHumanUserMessage(requestOptions.messages[index])) { turnStart = index; break }
    }
    const latestUser = [...(requestOptions.messages ?? [])].reverse().find((message) => isHumanUserMessage(message))
    const latestUserText = (latestUser?.content ?? [])
      .filter((block) => block.type === 'text' || block.type === 'reasoning')
      .map((block) => block.text)
      .join(' ')
    const toolContext = {
      currentSandboxMode: runtimeSandboxMode(requestOptions),
      blockExternalWebFallback: failedGeminiWebSearchInTurn(requestOptions.messages, turnStart),
      latestUserText,
      priorSearchSources: collectPriorSearchSources(requestOptions.messages),
      priorClaimVerifications: collectPriorClaimVerifications(requestOptions.messages),
      now: new Date(),
    }
    const researchArtifacts = researchArtifactState(requestOptions.messages, turnStart)
    const researchLike = toolContext.priorClaimVerifications.length > 0 && researchArtifacts.hasLongDraft
    const researchVerificationPending = researchLike && (
      pendingResearchVerification(requestOptions.messages, turnStart)
      || pendingWrittenDraftVerification(requestOptions.messages, turnStart, latestUserText)
    )
    const openAICompatibility = shouldUseOpenAICompatibility(requestOptions)
    const attachments = this.config.resolveAttachments?.()
    const body = await (openAICompatibility ? buildOpenAIRequest : buildGeminiRequest)(requestOptions, {
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
      : `${this.baseURL}/v1beta/models/${encodeURIComponent(requestOptions.model)}:streamGenerateContent?alt=sse`
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
    const contentBlocks = new Map()
    const contentOrder = []
    let nextBlockIndex = 2
    let hasToolCalls = false
    const openAIToolCalls = new Map()
    const suppressedOpenAIToolCallIndexes = new Set()
    let emittedSearchCalls = 0
    const callSignatures = this.callSignatures
    let usage
    let nativeFinishReason
    let openAIFinishReason
    const emitContent = function* (blockType, text) {
      if (!text) return
      const index = blockType === 'reasoning' ? 1 : 0
      let block = contentBlocks.get(index)
      if (!block) {
        block = { blockType, text: '' }
        contentBlocks.set(index, block)
        contentOrder.push(index)
        yield { type: 'block-start', index, blockType }
      }
      block.text += text
      yield { type: blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text }
    }
    const internalRuntimeEchoPrefix = 'A previously requested tool execution completed.'
    let providerTextMode = 'pending'
    let pendingProviderText = ''
    let deferProviderText = researchLike && researchCompletionState(requestOptions.messages, turnStart)
    let deferredProviderText = ''
    const emitProviderTextNow = function* (text) {
      if (!text) return
      if (providerTextMode !== 'pending') {
        yield* emitContent(providerTextMode, text)
        return
      }
      pendingProviderText += text
      const probe = pendingProviderText.trimStart()
      if (probe.startsWith(internalRuntimeEchoPrefix)) providerTextMode = 'reasoning'
      else if (probe && internalRuntimeEchoPrefix.startsWith(probe)) return
      else providerTextMode = 'text'
      const buffered = pendingProviderText
      pendingProviderText = ''
      yield* emitContent(providerTextMode, buffered)
    }
    const emitProviderText = function* (text) {
      if (!text) return
      if (deferProviderText) {
        deferredProviderText += text
        return
      }
      yield* emitProviderTextNow(text)
    }
    const releaseDeferredProviderText = function* (compact) {
      if (!deferProviderText) return
      deferProviderText = false
      if (!deferredProviderText) return
      const buffered = deferredProviderText
      deferredProviderText = ''
      yield* emitProviderTextNow(compact
        ? compactResearchFinalText(buffered, {
            artifacts: researchArtifacts,
            verifications: toolContext.priorClaimVerifications,
            verificationPending: researchVerificationPending,
          })
        : buffered)
    }
    const flushProviderText = function* () {
      if (!pendingProviderText) return
      const buffered = pendingProviderText
      pendingProviderText = ''
      providerTextMode = 'text'
      yield* emitContent('text', buffered)
    }
    const emitNativeEvent = function* (event) {
      if (event?.error) {
        const message = event.error.message ?? JSON.stringify(event.error)
        throw responseFailure(`AI Studio proxy stream error: ${message}`, event.error.code)
      }
      if (event?.promptFeedback?.blockReason) {
        throw responseFailure(`AI Studio blocked the prompt: ${event.promptFeedback.blockReason}`)
      }
      const candidates = event?.candidates ?? []
      for (const candidate of candidates) {
        if (candidate.finishReason) nativeFinishReason = candidate.finishReason
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            if (part.thought) yield* emitContent('reasoning', part.text)
            else yield* emitProviderText(part.text)
          }
          if (part.functionCall) {
            yield* releaseDeferredProviderText(false)
            const call = part.functionCall
            if (call.name === GEMINI_WEB_SEARCH_TOOL) {
              if (emittedSearchCalls >= 1) continue
              emittedSearchCalls += 1
            }
            const index = nextBlockIndex++
            const id = call.id ?? `gemini-call-${index}`
            if (call.thoughtSignature) callSignatures.set(id, call.thoughtSignature)
            const args = normalizeToolArguments(call.name, JSON.stringify(call.args ?? {}), toolParameters.get(call.name), toolContext)
            hasToolCalls = true
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
          }
        }
      }
      if (event?.usageMetadata) usage = event.usageMetadata
    }
    const parseData = function* (raw) {
      if (!raw || raw === '[DONE]') return
      let event
      try { event = JSON.parse(raw) } catch { return }
      if (!openAICompatibility) {
        yield* emitNativeEvent(event)
        return
      }
      if (event?.error) {
        const message = event.error.message ?? JSON.stringify(event.error)
        throw responseFailure(`AI Studio proxy stream error: ${message}`, event.error.status ?? event.error.code)
      }
      const choice = event.choices?.[0]
      const delta = choice?.delta ?? {}
      if (choice?.finish_reason) openAIFinishReason = choice.finish_reason
      if (delta.content) yield* emitProviderText(delta.content)
      const reasoning = delta.reasoning_content ?? delta.thinking
      if (reasoning) yield* emitContent('reasoning', reasoning)
      if ((delta.tool_calls ?? []).length) yield* releaseDeferredProviderText(false)
      for (const call of delta.tool_calls ?? []) {
        const providerIndex = call.index ?? 0
        if (suppressedOpenAIToolCallIndexes.has(providerIndex)) continue
        let current = openAIToolCalls.get(providerIndex)
        const startsAnotherCall = current && (
          call.id && call.id !== current.id
          || call.function?.name && current.name && call.function.name !== current.name
        )
        if (startsAnotherCall) {
          yield { type: 'block-end', index: current.index, block: { type: 'tool-call', id: current.id, name: current.name, arguments: normalizeToolArguments(current.name, current.arguments, toolParameters.get(current.name), toolContext) } }
          openAIToolCalls.delete(providerIndex)
          current = undefined
        }
        if (!current) {
          const callName = call.function?.name ?? ''
          if (callName === GEMINI_WEB_SEARCH_TOOL) {
            if (emittedSearchCalls >= 1) {
              suppressedOpenAIToolCallIndexes.add(providerIndex)
              continue
            }
            emittedSearchCalls += 1
          }
          const index = nextBlockIndex++
          current = { index, id: call.id ?? `gemini-call-${index}`, name: callName, arguments: '' }
          openAIToolCalls.set(providerIndex, current)
          hasToolCalls = true
          yield { type: 'block-start', index: current.index, blockType: 'tool-call' }
        }
        if (call.id) current.id = call.id
        if (call.function?.name) current.name = call.function.name
        const deltaArgs = call.function?.arguments ?? ''
        current.arguments += deltaArgs
        yield { type: 'tool-call-delta', index: current.index, id: current.id, name: current.name || undefined, argumentsDelta: deltaArgs }
      }
      if (event.usage) usage = event.usage
    }
    let dataLines = []
    const parseLine = function* (line) {
      if (line === '') {
        if (dataLines.length) yield* parseData(dataLines.splice(0).join('\n').trim())
        return
      }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* parseLine(line)
      if (done) {
        if (buffer) yield* parseLine(buffer)
        if (dataLines.length) yield* parseData(dataLines.splice(0).join('\n').trim())
        break
      }
    }
    yield* releaseDeferredProviderText(true)
    yield* flushProviderText()
    for (const call of openAIToolCalls.values()) {
      yield { type: 'block-end', index: call.index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: normalizeToolArguments(call.name, call.arguments, toolParameters.get(call.name), toolContext) } }
    }
    for (const index of contentOrder) {
      const block = contentBlocks.get(index)
      yield { type: 'block-end', index, block: { type: block.blockType, text: block.text } }
    }
    if (usage) yield { type: 'usage', usage: { inputTokens: usage.promptTokenCount ?? usage.prompt_tokens ?? 0, outputTokens: usage.candidatesTokenCount ?? usage.completion_tokens ?? 0, reasoningTokens: usage.thoughtsTokenCount ?? usage.completion_tokens_details?.reasoning_tokens } }
    if (!contentBlocks.size && !hasToolCalls) {
      yield finishFailure('AI Studio returned a completed response with no text, reasoning, or tool calls', 'EMPTY_RESPONSE')
      return
    }
    const providerFailure = nativeFinishReason && !['STOP', 'MAX_TOKENS'].includes(nativeFinishReason)
      ? `AI Studio stopped the response with ${nativeFinishReason}`
      : openAIFinishReason && !['stop', 'length', 'tool_calls'].includes(openAIFinishReason)
        ? `AI Studio stopped the response with ${openAIFinishReason}`
        : undefined
    if (providerFailure) yield finishFailure(providerFailure)
    else yield finish(finishKind(nativeFinishReason, openAIFinishReason, hasToolCalls))
  }
}

export function apply(ctx, config = {}) {
  const llm = ctx.llm
  const effective = {
    provider: configValue(config, 'provider', 'aistudio-gemini'),
    baseURL: configValue(config, 'baseURL', 'http://127.0.0.1:8080'),
    apiKeyEnv: configValue(config, 'apiKeyEnv', 'AISTUDIO_API_KEY'),
    googleSearch: configValue(config, 'googleSearch', true),
    searchMaxCallsPerTurn: configValue(config, 'searchMaxCallsPerTurn', 6),
    searchModel: configValue(config, 'searchModel', undefined),
    searchFallbackModel: configValue(config, 'searchFallbackModel', undefined),
    models: configValue(config, 'models', ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview']),
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
  const sourceCache = new WeakMap()
  registerNativeWebSearchTool(ctx, effective, sourceCache)
  registerNativeClaimVerificationTool(ctx, effective, sourceCache)
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
