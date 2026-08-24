import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGeminiRequest, buildOpenAIRequest } from '../lib/request.js'
import { GeminiAdapter, normalizeToolArguments, reasoningMetadata, shouldUseOpenAICompatibility } from '../lib/index.js'

test('repairs missing pwsh description without changing other tools', () => {
  assert.equal(normalizeToolArguments('pwsh', '{"command":"Get-Date"}'), '{"command":"Get-Date","description":"Run PowerShell command"}')
  assert.equal(normalizeToolArguments('pwsh', '{"command":"Get-Date","description":"Read the date"}'), '{"command":"Get-Date","description":"Read the date"}')
  assert.equal(normalizeToolArguments('write', '{"file_path":"out.md","content":"text","justification":"write the file"}'), '{"file_path":"out.md","content":"text"}')
  assert.equal(normalizeToolArguments('write', '{"file_path":"out.md","content":"text","sandbox_permissions":"danger-full-access","justification":"write outside workspace"}'), '{"file_path":"out.md","content":"text","sandbox_permissions":"danger-full-access","justification":"write outside workspace"}')
  assert.equal(normalizeToolArguments('read', '{"path":"README.md"}'), '{"path":"README.md"}')
  assert.equal(normalizeToolArguments('todo_write', '{"todos":[null,{"content":"Test","status":"pending"},null]}'), '{"todos":[{"content":"Test","status":"pending"}]}')
})

test('keeps image and PDF turns on the native Gemini route even when tools are present', () => {
  const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]
  assert.equal(shouldUseOpenAICompatibility({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools }), true)
  assert.equal(shouldUseOpenAICompatibility({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1' } }] }], tools }), false)
  assert.equal(shouldUseOpenAICompatibility({ messages: [{ role: 'user', content: [{ type: 'text', text: '[[dsh-gemini-file:C:\\tmp\\report.pdf]]' }] }], tools }), false)
})

test('model discovery falls back without a credential and still declares vision and reasoning', async () => {
  const adapter = new GeminiAdapter({
    provider: 'aistudio-gemini',
    baseURL: 'http://127.0.0.1:8080',
    models: ['gemini-3.7-flash'],
    pdf: { enabled: true },
    resolveApiKey: async () => undefined,
  })
  const [model] = await adapter.listModels('aistudio-gemini')
  assert.deepEqual(model.inputModalities, ['text', 'image'])
  assert.equal(model.reasoning.defaultEffort, 'high')
})

test('imports complete model metadata from the proxy catalog', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{
        id: 'gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        input_modalities: ['text', 'image'],
        context_window: 1_000_000,
        max_output_tokens: 65_536,
        reasoning_efforts: ['minimal', 'low', 'medium', 'high'],
        default_reasoning_effort: 'high',
      }],
    }),
  })
  try {
    const adapter = new GeminiAdapter({
      provider: 'aistudio-gemini',
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-3.7-flash'],
      pdf: { enabled: true },
      resolveApiKey: async () => 'test-key',
    })
    const [model] = await adapter.listModels('aistudio-gemini')
    assert.equal(model.id, 'gemini-3.7-flash')
    assert.equal(model.name, 'Gemini 3.7 Flash')
    assert.deepEqual(model.inputModalities, ['text', 'image'])
    assert.deepEqual(model.context, { contextWindow: 1_000_000 })
    assert.equal(model.defaultMaxTokens, 65_536)
    assert.deepEqual(model.reasoning.efforts.map((effort) => effort.id), ['minimal', 'low', 'medium', 'high'])
    assert.equal(model.reasoning.defaultEffort, 'high')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('coalesces concurrent model discovery requests', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { ok: true, json: async () => ({ data: [{ id: 'gemini-3.7-flash' }] }) }
  }
  try {
    const adapter = new GeminiAdapter({
      provider: 'aistudio-gemini', baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-3.7-flash'], pdf: { enabled: true },
      resolveApiKey: async () => 'test-key',
    })
    await Promise.all([adapter.fetchModels(), adapter.fetchModels(), adapter.fetchModels()])
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('builds native Google Search for a plain prompt', async () => {
  const request = await buildGeminiRequest({
    system: 'be concise',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'search this' }] }],
  }, { googleSearch: true, pdfCache: { get: async () => { throw new Error('not expected') } } })
  assert.deepEqual(request.systemInstruction.parts, [{ text: 'be concise' }])
  assert.equal(request.tools[0].googleSearch !== undefined, true)
  assert.equal(request.tools[0].googleSearch !== undefined, true)
})

test('maps dsh reasoning effort to Gemini thinking level', async () => {
  const request = await buildGeminiRequest({
    reasoningEffort: 'medium',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
  }, { googleSearch: false })
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' })
})

test('advertises selectable reasoning efforts with high as the default', () => {
  assert.deepEqual(reasoningMetadata(), {
    efforts: [
      { id: 'minimal', name: 'Minimal' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  })
  assert.equal(reasoningMetadata({ reasoning: false }), undefined)
})

test('implements the dsh prepared-call adapter contract', async () => {
  const adapter = new GeminiAdapter({
    provider: 'aistudio-gemini',
    baseURL: 'http://127.0.0.1:8090',
    pdf: { enabled: true },
  })
  adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model })
  adapter.stream = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }

  const prepared = await adapter.prepareCall('aistudio-gemini', 'gemini-3.7-flash')
  assert.equal(prepared.model.provider, 'aistudio-gemini')
  assert.equal(prepared.model.id, 'gemini-3.7-flash')
  assert.deepEqual(await Array.fromAsync(prepared.stream({})), [
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('forwards reasoning effort through OpenAI tool-call requests', async () => {
  const request = await buildOpenAIRequest({
    model: 'gemini-3.7-flash',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  }, {})

  assert.equal(request.reasoning_effort, 'high')
})

test('does not mix Google Search into Gemini function-tool turns', async () => {
  const request = await buildGeminiRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'use read' }] }],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  }, { googleSearch: true, pdfCache: { get: async () => { throw new Error('not expected') } } })
  assert.equal(request.tools.some((tool) => tool.googleSearch), false)
  assert.equal(request.tools.some((tool) => tool.functionDeclarations), true)
})

test('preserves Gemini thought signatures on dsh function-call history', async () => {
  const request = await buildGeminiRequest({
    messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }] }],
  }, { googleSearch: false, callSignatures: new Map([['call_1', 'sig_1']]) })
  assert.equal(request.contents[0].parts[0].thoughtSignature, 'sig_1')
})

test('attaches a PDF path only to the latest user message', async () => {
  const request = await buildGeminiRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'C:\\old.pdf' }] },
      { role: 'user', content: [{ type: 'text', text: 'C:\\new.pdf' }] },
    ],
  }, { googleSearch: false, pdfConfig: { enabled: true }, pdfCache: {
    get: async (filePath) => ({ mimeType: 'application/pdf', data: 'UEFERg==', bytes: 4, pages: 1, path: filePath }),
  } })
  assert.equal(request.contents[0].parts.some((part) => part.inlineData), false)
  assert.equal(request.contents[1].parts.some((part) => part.inlineData?.mimeType === 'application/pdf'), true)
})

test('attaches an uploaded original image marker without dsh image normalization', async () => {
  const request = await buildGeminiRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: '[Gemini附件：photo.png]\n[[dsh-gemini-file:C:\\tmp\\photo.png]]' }] }],
  }, { googleSearch: false, pdfConfig: { enabled: true }, mediaCache: {
    get: async () => ({ mimeType: 'image/png', data: 'UE5H', bytes: 3 }),
  } })
  assert.equal(request.contents[0].parts.some((part) => part.inlineData?.mimeType === 'image/png'), true)
})
