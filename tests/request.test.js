import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGeminiRequest } from '../lib/request.js'

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
