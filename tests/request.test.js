import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGeminiRequest, buildOpenAIRequest, sanitizeToolSchema } from '../lib/request.js'
import { GeminiAdapter, apply, normalizeToolArguments, prepareAgentExecution, prepareSearchConvergence, reasoningMetadata, runNativeWebLookup, shouldUseOpenAICompatibility } from '../lib/index.js'

function streamResponse(chunks) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function adapterForStream(overrides = {}) {
  return new GeminiAdapter({
    provider: 'aistudio-gemini',
    baseURL: 'http://127.0.0.1:8080',
    models: ['gemini-test'],
    pdf: { enabled: true },
    googleSearch: false,
    resolveApiKey: async () => 'test-key',
    ...overrides,
  })
}

function validateStrictStream(chunks) {
  const open = new Map()
  let usageSeen = false
  let finished = false
  for (const chunk of chunks) {
    assert.equal(finished, false, `${chunk.type} emitted after finish`)
    if (chunk.type === 'block-start') {
      assert.equal(open.has(chunk.index), false, `duplicate block index ${chunk.index}`)
      open.set(chunk.index, chunk.blockType)
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const expected = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      assert.equal(open.get(chunk.index), expected, `${chunk.type} requires an open ${expected} block`)
    } else if (chunk.type === 'tool-call-delta') {
      assert.equal(open.get(chunk.index), 'tool-call', 'tool delta requires an open tool block')
    } else if (chunk.type === 'block-end') {
      assert.equal(open.get(chunk.index), chunk.block.type, `block ${chunk.index} closed with the wrong type`)
      open.delete(chunk.index)
    } else if (chunk.type === 'usage') {
      assert.equal(usageSeen, false, 'usage emitted twice')
      usageSeen = true
    } else if (chunk.type === 'finish') {
      assert.equal(open.size, 0, 'finish emitted with open blocks')
      finished = true
    }
  }
  assert.equal(finished, true, 'stream did not finish')
}

async function collectMockedStream(response, options, adapter = adapterForStream()) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => response
  try {
    return { adapter, chunks: await Array.fromAsync(adapter.stream(options)) }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('repairs missing pwsh description without changing other tools', () => {
  assert.equal(normalizeToolArguments('pwsh', '{"command":"Get-Date"}'), '{"command":"Get-Date","description":"Run PowerShell command"}')
  assert.equal(normalizeToolArguments('pwsh', '{"command":"Get-Date","description":"Read the date"}'), '{"command":"Get-Date","description":"Read the date"}')
  assert.equal(normalizeToolArguments('read', '{"path":"README.md"}'), '{"path":"README.md"}')
})

test('removes orphaned escalation justification for every tool', () => {
  assert.equal(
    normalizeToolArguments('write', '{"file_path":"note.txt","content":"ok","justification":"write it"}'),
    '{"file_path":"note.txt","content":"ok"}',
  )
  assert.deepEqual(
    normalizeToolArguments('custom_tool', {
      value: 1,
      sandbox_permissions: 'danger-full-access',
      justification: 'Access the explicitly requested external target.',
    }),
    {
      value: 1,
      sandbox_permissions: 'danger-full-access',
      justification: 'Access the explicitly requested external target.',
    },
  )
})

test('removes only non-widening sandbox escalation requests', () => {
  const args = {
    file_path: 'note.txt',
    content: 'ok',
    sandbox_permissions: 'workspace-write',
    justification: 'Write outside the read-only standing mode.',
  }
  assert.deepEqual(
    normalizeToolArguments('write', args, undefined, { currentSandboxMode: 'workspace-write' }),
    { file_path: 'note.txt', content: 'ok' },
  )
  assert.deepEqual(
    normalizeToolArguments('write', args, undefined, { currentSandboxMode: 'read-only' }),
    args,
  )
  assert.deepEqual(
    normalizeToolArguments('write', {
      ...args,
      sandbox_permissions: 'danger-full-access',
    }, undefined, { currentSandboxMode: 'workspace-write' }),
    { ...args, sandbox_permissions: 'danger-full-access' },
  )
})

test('converts comma-separated include filters into one brace-alternation glob', () => {
  const schema = {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      include: { type: 'string', description: 'One glob filter. Not a list.' },
    },
  }
  assert.equal(
    normalizeToolArguments('grep', '{"pattern":"TODO","include":"*.js, *.ts"}', schema),
    '{"pattern":"TODO","include":"{*.js,*.ts}"}',
  )
  assert.equal(
    normalizeToolArguments('grep', '{"pattern":"TODO","include":"*.{js,ts}"}', schema),
    '{"pattern":"TODO","include":"*.{js,ts}"}',
  )
})

test('does not invent missing required file content', () => {
  const schema = {
    type: 'object',
    required: ['file_path', 'content'],
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
  }
  assert.equal(
    normalizeToolArguments('write', '{"file_path":"note.txt"}', schema),
    '{"file_path":"note.txt"}',
  )
})

test('repairs arbitrary tool arguments from their JSON Schema', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } } },
      },
      mode: { type: 'string' },
    },
  }
  assert.equal(
    normalizeToolArguments('any_batch_tool', '{"items":[null,{"value":"ok","invented":true},7],"mode":"safe","unknown":"drop"}', schema),
    '{"items":[{"value":"ok"}],"mode":"safe"}',
  )
})

test('drops optional null scalars and safely coerces common Gemini scalar mismatches', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      run_in_background: { type: 'boolean' },
      timeout_ms: { type: 'integer' },
      temperature: { type: 'number' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      label: { type: 'string' },
    },
  }
  assert.equal(
    normalizeToolArguments('subagent', '{"run_in_background":null,"timeout_ms":"30000","temperature":"0.25","status":"COMPLETED","label":7}', schema),
    '{"timeout_ms":30000,"temperature":0.25,"status":"completed","label":"7"}',
  )
})

test('preserves schema-approved nulls and fills deterministic required defaults', () => {
  const schema = {
    type: 'object',
    required: ['mode', 'attempts'],
    properties: {
      exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      mode: { type: 'string', enum: ['safe'] },
      attempts: { type: 'integer', default: 1 },
    },
  }
  assert.deepEqual(
    normalizeToolArguments('workflow', { exit_code: null, mode: null, attempts: null }, schema),
    { exit_code: null, mode: 'safe', attempts: 1 },
  )
})

test('preserves enum-approved nulls and does not invent required scalar values', () => {
  const schema = {
    type: 'object',
    required: ['decision'],
    properties: {
      optional_state: { enum: [null, 'ready'] },
      decision: { type: 'boolean' },
    },
  }
  assert.deepEqual(
    normalizeToolArguments('approval', { optional_state: null, decision: null }, schema),
    { optional_state: null, decision: null },
  )
})

test('repairs nested arrays for boolean, integer, enum, and object item schemas', () => {
  const schema = {
    type: 'object',
    properties: {
      flags: { type: 'array', items: { type: 'boolean' } },
      indexes: { type: ['array', 'null'], items: { type: 'integer' } },
      statuses: { type: 'array', items: { type: 'string', enum: ['pending', 'completed'] } },
      todos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['content', 'status'],
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'completed'] },
          },
        },
      },
    },
  }
  assert.deepEqual(
    normalizeToolArguments('batch', {
      flags: ['true', null, false],
      indexes: ['1', 2, null],
      statuses: ['PENDING', null, 'completed'],
      todos: [null, { content: 'verify', status: 'COMPLETED', extra: true }, 7],
    }, schema),
    {
      flags: [true, false],
      indexes: [1, 2],
      statuses: ['pending', 'completed'],
      todos: [{ content: 'verify', status: 'completed' }],
    },
  )
})

test('conservatively removes streamed JSON leakage after an unambiguous enum value', () => {
  const schema = {
    type: 'object',
    required: ['todos'],
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          required: ['content', 'status'],
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
        },
      },
    },
  }
  assert.deepEqual(
    normalizeToolArguments('todo_write', {
      todos: [{ content: 'Collect sources', status: 'in_progress\"},{\"content:' }],
    }, schema),
    { todos: [{ content: 'Collect sources', status: 'in_progress' }] },
  )
  assert.deepEqual(
    normalizeToolArguments('todo_write', {
      todos: [{ content: 'Collect sources', status: 'in_progress_extra' }],
    }, schema),
    { todos: [{ content: 'Collect sources', status: 'in_progress_extra' }] },
  )
})

test('preserves user relative-time constraints in Gemini search arguments automatically', () => {
  const raw = JSON.stringify({ query: 'AI chip supply chain news August 2026' })
  const normalized = JSON.parse(normalizeToolArguments('gemini_web_search', raw, {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  }, {
    latestUserText: '帮我核实过去24小时最重要的消息，不要拿旧闻代替。',
    now: new Date(2026, 7, 26, 12, 30, 0),
  }))
  assert.match(normalized.query, /Relative-time wording from the user: "过去24小时"/)
  assert.match(normalized.query, /Exact requested rolling window for "过去24小时": 2026-08-25/)
  assert.match(normalized.query, /through 2026-08-26/)
})

test('fills required description fields recursively from any tool schema', () => {
  const schema = {
    type: 'object',
    required: ['code', 'description', 'meta'],
    properties: {
      code: { type: 'string' },
      description: { type: 'string' },
      meta: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  }
  assert.deepEqual(
    normalizeToolArguments('run_code', { code: 'return 1', meta: { name: 'check' } }, schema),
    {
      code: 'return 1',
      description: 'Execute the requested run code operation',
      meta: { name: 'check', description: 'Execute the requested run code operation' },
    },
  )
})

test('preserves undeclared fields unless JSON Schema explicitly forbids them', () => {
  const openSchema = {
    type: 'object',
    properties: { known: { type: 'string' } },
  }
  assert.equal(
    normalizeToolArguments('open_tool', '{"known":"yes","extension":{"value":1}}', openSchema),
    '{"known":"yes","extension":{"value":1}}',
  )
})

test('keeps image and PDF turns on the native Gemini route even when tools are present', () => {
  const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]
  assert.equal(shouldUseOpenAICompatibility({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools }), true)
  assert.equal(shouldUseOpenAICompatibility({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1' } }] }], tools }), false)
  assert.equal(shouldUseOpenAICompatibility({ messages: [{ role: 'user', content: [{ type: 'text', text: '[[dsh-gemini-file:C:\\tmp\\report.pdf]]' }] }], tools }), false)
})

test('repairs untyped third-party tool schemas before either proxy route', async () => {
  const tool = {
    name: 'dev_stage_call',
    description: 'Call a staged tool',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args: { description: 'Optional JSON arguments' },
      },
      required: ['name'],
    },
  }
  const options = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [tool] }

  assert.deepEqual(sanitizeToolSchema(tool.parameters).properties.args, {
    type: 'object',
    description: 'Optional JSON arguments',
    properties: {},
  })
  const native = await buildGeminiRequest(options, { googleSearch: false })
  const openai = await buildOpenAIRequest(options, {})
  assert.equal(native.tools[0].functionDeclarations[0].parameters.properties.args.type, 'object')
  assert.equal(openai.tools[0].function.parameters.properties.args.type, 'object')
})

test('preserves reasoning as reasoning history instead of normal answer text', async () => {
  const options = {
    model: 'gemini-3.7-flash',
    messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'private analysis' }, { type: 'text', text: 'visible answer' }] }],
  }
  const native = await buildGeminiRequest(options, { googleSearch: false })
  const openai = await buildOpenAIRequest(options, {})

  assert.deepEqual(native.contents[0].parts, [{ text: 'private analysis', thought: true }, { text: 'visible answer' }])
  assert.equal(openai.messages[0].reasoning_content, 'private analysis')
  assert.equal(openai.messages[0].content, 'visible answer')
})

test('adds general agent continuation guidance whenever tools are available', () => {
  const prepared = prepareAgentExecution({ system: 'base', tools: [{ name: 'read' }] })
  assert.match(prepared.system, /call that tool instead of ending the turn with a plan/)
  assert.match(prepared.system, /Keep private analysis and reasoning out of normal answer text/)
  assert.match(prepared.system, /check the supplied JSON Schema/)
  assert.match(prepared.system, /failed tool result is not progress/)
  assert.match(prepared.system, /File existence alone proves neither content quality nor format correctness/)
  assert.doesNotMatch(prepared.system, /Task-list progress rules/)
  assert.equal(prepareAgentExecution({ system: 'base', tools: [] }).system, 'base')
})

test('adds task-list lifecycle guidance for semantically matching tools', () => {
  const taskTool = {
    name: 'work_plan_update',
    description: 'Replace the current work plan',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
    },
  }
  const prepared = prepareAgentExecution({ system: 'base', tools: [taskTool] })
  assert.match(prepared.system, /Treat the latest successful task-list write as the canonical list/)
  assert.match(prepared.system, /Do not call the task-list tool unless at least one status or the real task scope changed/)
  assert.match(prepared.system, /Before the final answer, send one final entire-list update/)
})

test('temporarily removes task-list tools until a non-task tool result makes progress', () => {
  const todo = {
    name: 'todo_write',
    description: 'Record and update a structured task list',
    parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } } },
  }
  const read = { name: 'read', parameters: { type: 'object' } }
  const afterTodoOnly = prepareAgentExecution({
    system: 'base',
    tools: [todo, read],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect the project' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'todo-1', name: 'todo_write', arguments: '{"todos":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'todo-1', content: [{ type: 'text', text: 'Updated todo list.' }] }] },
    ],
  })
  assert.deepEqual(afterTodoOnly.tools.map((tool) => tool.name), ['read'])
  assert.match(afterTodoOnly.system, /latest successful write has no intervening non-task tool result/)

  const afterRealProgress = prepareAgentExecution({
    ...afterTodoOnly,
    tools: [todo, read],
    messages: [
      ...afterTodoOnly.messages,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'read-1', name: 'read', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: 'package contents' }] }] },
    ],
  })
  assert.deepEqual(afterRealProgress.tools.map((tool) => tool.name), ['todo_write', 'read'])
})

test('does not count failed tools as task progress or failed task writes as canonical state', () => {
  const todo = {
    name: 'todo_write',
    description: 'Record and update a structured task list',
    parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } } },
  }
  const subagent = { name: 'subagent', parameters: { type: 'object' } }
  const afterFailedWork = prepareAgentExecution({
    tools: [todo, subagent],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'build it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'todo-1', name: 'todo_write', arguments: '{"todos":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'todo-1', content: [{ type: 'text', text: 'Updated todo list.' }], isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'sub-1', name: 'subagent', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'sub-1', content: [{ type: 'text', text: 'Error: invalid arguments' }], isError: true }] },
    ],
  })
  assert.deepEqual(afterFailedWork.tools.map((tool) => tool.name), ['subagent'])

  const afterFailedTodo = prepareAgentExecution({
    tools: [todo, subagent],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'build it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'todo-1', name: 'todo_write', arguments: '{"todos":[null]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'todo-1', content: [{ type: 'text', text: 'Error: invalid arguments' }], isError: true }] },
    ],
  })
  assert.deepEqual(afterFailedTodo.tools.map((tool) => tool.name), ['todo_write', 'subagent'])
})

test('keeps OpenAI compatibility after convergence removes tools from a tool-call turn', () => {
  assert.equal(shouldUseOpenAICompatibility({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'glob', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'No files found' }], isError: false }] },
    ],
    tools: [],
  }), true)
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
  assert.deepEqual(request.tools, [{ googleSearch: {} }])
})

test('removes DeepSeek web tools and stops repeated Gemini native searches', () => {
  const tools = [
    { name: 'web_search', description: 'Search', parameters: { type: 'object' } },
    { name: 'web_fetch', description: 'Fetch', parameters: { type: 'object' } },
    { name: 'gemini_web_search', description: 'Gemini Search', parameters: { type: 'object' } },
    { name: 'read', description: 'Read', parameters: { type: 'object' } },
  ]
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Find GitHub owner/repo' }] },
    ...Array.from({ length: 4 }, (_, index) => ({
      role: 'assistant',
      content: [{ type: 'tool-call', id: `search-${index}`, name: 'gemini_web_search', arguments: JSON.stringify({ query: `owner repo ${index}` }) }],
    })),
  ]
  const prepared = prepareSearchConvergence({ system: 'base', messages, tools }, 4)
  assert.equal(prepared.tools.some((tool) => tool.name === 'web_search'), false)
  assert.equal(prepared.tools.some((tool) => tool.name === 'web_fetch'), false)
  assert.equal(prepared.tools.some((tool) => tool.name === 'gemini_web_search'), false)
  assert.match(prepared.system, /budget .* exhausted/i)
  assert.match(prepared.system, /GitHub owner\/repository/)
})

test('keeps first-pass Gemini native search and removes legacy web tools', () => {
  const prepared = prepareSearchConvergence({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Find an exact package' }] }],
    tools: [
      { name: 'web_search', parameters: { type: 'object' } },
      { name: 'web_fetch', parameters: { type: 'object' } },
      { name: 'gemini_web_search', parameters: { type: 'object' } },
    ],
  })
  assert.equal(prepared.tools.some((tool) => tool.name === 'web_search'), false)
  assert.equal(prepared.tools.some((tool) => tool.name === 'web_fetch'), false)
  assert.equal(prepared.tools.some((tool) => tool.name === 'gemini_web_search'), true)
  assert.match(prepared.system, /Gemini native Google Search and URL Context/)
  assert.match(prepared.system, /Never replace an unverified exact target/)
  assert.match(prepared.system, /quoted-name discovery lookup/)
  assert.match(prepared.system, /primary page establishes the final fact/)
  assert.match(prepared.system, /Copy every cited URL exactly/)
  assert.match(prepared.system, /generic home page.*is not evidence/)
  assert.match(prepared.system, /publication dates and event dates/)
  assert.match(prepared.system, /non-network local dsh tools for deterministic computation/)
  assert.match(prepared.system, /workspace and file inspection, transformations, and result verification/)
  assert.match(prepared.system, /Do not use shell commands, package-manager commands, scripts, or local browser tools to access public/)
  assert.match(prepared.system, /Treat a successful non-network tool result as authoritative/)
  assert.match(prepared.system, /Never rerun a semantically equivalent local operation/)
  assert.match(prepared.system, /two independent local discovery attempts both return empty/)
})

test('stops near-equivalent successful web searches while preserving distinct research queries', () => {
  const tools = [
    { name: 'gemini_web_search', parameters: { type: 'object' } },
    { name: 'read', parameters: { type: 'object' } },
  ]
  const commonMessages = [
    { role: 'user', content: [{ type: 'text', text: 'Find the latest stable Python release' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'search-1', name: 'gemini_web_search', arguments: '{"query":"https://www.python.org/downloads/"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'search-1', content: [{ type: 'text', text: 'Official Python downloads page with current release information and source links.' }], isError: false }] },
  ]
  const redundant = prepareSearchConvergence({
    messages: [
      ...commonMessages,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'search-2', name: 'gemini_web_search', arguments: '{"query":"\\"latest Python release\\" site:python.org/downloads/"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'search-2', content: [{ type: 'text', text: 'Python 3.14.7 is the latest release. Official source: https://www.python.org/downloads/release/python-3147/' }], isError: false }] },
    ],
    tools,
  })
  assert.equal(redundant.tools.some((tool) => tool.name === 'gemini_web_search'), false)
  assert.deepEqual(redundant.tools.map((tool) => tool.name), ['read'])
  assert.match(redundant.system, /near-equivalent queries/)

  const distinct = prepareSearchConvergence({
    messages: [
      ...commonMessages,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'search-2', name: 'gemini_web_search', arguments: '{"query":"Django security advisories site:python.org"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'search-2', content: [{ type: 'text', text: 'Distinct security advisory research result with enough substantive details.' }], isError: false }] },
    ],
    tools,
  })
  assert.equal(distinct.tools.some((tool) => tool.name === 'gemini_web_search'), true)
})

test('suppresses only a repeatedly invalid tool while preserving other tools', () => {
  const prepared = prepareSearchConvergence({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'delegate two tasks' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'sub-1', name: 'subagent', arguments: '{"prompt":"backend","run_in_background":null}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'sub-1', content: [{ type: 'text', text: 'Error: invalid arguments: "run_in_background" must be a boolean' }], isError: true }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'sub-2', name: 'subagent', arguments: '{"prompt":"frontend","run_in_background":null}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'sub-2', content: [{ type: 'text', text: 'Error: invalid arguments: "run_in_background" must be a boolean' }], isError: true }] },
    ],
    tools: [
      { name: 'subagent', parameters: { type: 'object' } },
      { name: 'read', parameters: { type: 'object' } },
      { name: 'todo_write', parameters: { type: 'object' } },
    ],
  })
  assert.deepEqual(prepared.tools.map((tool) => tool.name), ['read', 'todo_write'])
  assert.match(prepared.system, /repeatedly produced equivalent failures/)
  assert.match(prepared.system, /subagent/)
})

test('anchors relative-date web research to the runtime date instead of model memory', () => {
  const prepared = prepareSearchConvergence({
    system: 'base',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What happened in the past 24 hours?' }] }],
    tools: [{ name: 'gemini_web_search', parameters: { type: 'object' } }],
  }, 6, new Date(2026, 7, 26, 12, 0, 0))
  assert.match(prepared.system, /Runtime date anchor for this request: 2026-08-26/)
  assert.match(prepared.system, /Exact requested rolling window for "past 24 hours": 2026-08-25/)
  assert.match(prepared.system, /Put the resulting absolute date range in the search query/)
  assert.match(prepared.system, /Do not guess a month, year, or cutoff from model memory/)
  const search = prepared.tools.find((tool) => tool.name === 'gemini_web_search')
  assert.match(search.description, /Runtime date: 2026-08-26/)
  assert.match(search.description, /Exact requested rolling window for "past 24 hours": 2026-08-25/)
})

test('provides actionable recovery for common dsh tool failures without guessing data', () => {
  const cases = [
    {
      tool: 'write',
      error: 'Error: invalid arguments: missing required property "content"',
      expected: /complete intended file content/,
    },
    {
      tool: 'write',
      error: 'Error: sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode',
      expected: /Omit sandbox_permissions and justification/,
    },
    {
      tool: 'edit',
      error: 'Error: old_string was not found in "D:\\Document\\feedback-log.md"',
      expected: /Read the current target file/,
    },
    {
      tool: 'grep',
      error: 'Error: include must be one glob, not a comma-separated list (use {a,b} alternation instead)',
      expected: /brace-alternation glob/,
    },
    {
      tool: 'grep',
      error: 'Error: grep produced more raw output than the subprocess seam retained within the 20000000-byte cap; narrow pattern, path, or include and retry',
      expected: /Narrow the path/,
    },
    {
      tool: 'gemini_web_search',
      error: 'Error: tool "gemini_web_search" returned invalid output: value is not lossless JSON',
      expected: /non-empty, precise query/,
    },
    {
      tool: 'wait_agent',
      error: 'Error: unknown job 5962b031',
      expected: /runtime no longer recognizes/,
    },
    {
      tool: 'gemini_web_search',
      error: 'Error: Gemini native web lookup returned HTTP 500: The caller does not have permission',
      expected: /retry the same substantive lookup at most once/,
    },
  ]
  for (const [index, entry] of cases.entries()) {
    const prepared = prepareSearchConvergence({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'continue the task' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: `call-${index}`, name: entry.tool, arguments: '{}' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: `call-${index}`, content: [{ type: 'text', text: entry.error }], isError: true }] },
      ],
      tools: [{ name: entry.tool, parameters: { type: 'object' } }, { name: 'read', parameters: { type: 'object' } }],
    })
    assert.match(prepared.system, entry.expected)
    assert.equal(prepared.tools.some((tool) => tool.name === entry.tool), true)
  }
})

test('stops repeated non-widening escalation failures while preserving read access', () => {
  const error = 'Error: sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode'
  const prepared = prepareSearchConvergence({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'write the report' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'write-1', name: 'write', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-1', content: [{ type: 'text', text: error }], isError: true }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'write-2', name: 'write', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-2', content: [{ type: 'text', text: error }], isError: true }] },
    ],
    tools: [{ name: 'write' }, { name: 'read' }],
  })
  assert.deepEqual(prepared.tools.map((tool) => tool.name), ['read'])
  assert.match(prepared.system, /repeatedly produced equivalent failures/)
})

test('keeps non-search tools available when native search reaches its budget', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'research and inspect the local file' }] },
    ...Array.from({ length: 4 }, (_, index) => ({
      role: 'assistant',
      content: [{ type: 'tool-call', id: `search-${index}`, name: 'gemini_web_search', arguments: JSON.stringify({ query: `query ${index}` }) }],
    })),
  ]
  const prepared = prepareSearchConvergence({
    messages,
    tools: [
      { name: 'gemini_web_search', parameters: { type: 'object' } },
      { name: 'read', parameters: { type: 'object' } },
      { name: 'pwsh', parameters: { type: 'object' } },
    ],
  }, 4)
  assert.deepEqual(prepared.tools.map((tool) => tool.name), ['read', 'pwsh'])
  assert.match(prepared.system, /continue with relevant non-network tools/)
})

test('temporarily suppresses only an exactly repeated local tool operation', () => {
  const baseTools = [
    { name: 'gemini_web_search', parameters: { type: 'object' } },
    { name: 'read', parameters: { type: 'object' } },
    { name: 'pwsh', parameters: { type: 'object' } },
  ]
  const duplicate = prepareSearchConvergence({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect once' }] },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"README.md","offset":0}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'contents' }] },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{"offset":0,"path":"README.md"}' }] },
    ],
    tools: baseTools,
  })
  assert.equal(duplicate.tools.some((tool) => tool.name === 'read'), false)
  assert.equal(duplicate.tools.some((tool) => tool.name === 'pwsh'), true)
  assert.match(duplicate.system, /exactly duplicates the preceding call/)

  const progressed = prepareSearchConvergence({
    messages: [
      ...duplicate.messages,
      { role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh', arguments: '{"command":"Write-Output ok"}' }] },
    ],
    tools: baseTools,
  })
  assert.equal(progressed.tools.some((tool) => tool.name === 'read'), true)
})

test('forces a user clarification after two distinct empty local discovery results', () => {
  const prepared = prepareSearchConvergence({
    system: 'base',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check this plugin' }] },
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'call_1', name: 'glob', arguments: '{"pattern":"*.js"}' },
        { type: 'tool-call', id: 'call_2', name: 'glob', arguments: '{"pattern":"package.json"}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'No files found' }], isError: false }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: '(no output)' }], isError: false }] },
    ],
    tools: [
      { name: 'glob', parameters: { type: 'object' } },
      { name: 'pwsh', parameters: { type: 'object' } },
      { name: 'gemini_web_search', parameters: { type: 'object' } },
    ],
  }, 4)
  assert.deepEqual(prepared.tools, [])
  assert.match(prepared.system, /2 distinct local discovery operations/)
  assert.match(prepared.system, /Ask the user for the missing workspace/)
})

test('does not force convergence after one empty result or any substantive result', () => {
  const oneEmpty = prepareSearchConvergence({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check this plugin' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'glob', arguments: '{"pattern":"*.js"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'No files found' }], isError: false }] },
    ],
    tools: [{ name: 'glob' }, { name: 'gemini_web_search' }],
  }, 4)
  assert.equal(oneEmpty.tools.some((tool) => tool.name === 'glob'), true)

  const withEvidence = prepareSearchConvergence({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check this plugin' }] },
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'call_1', name: 'glob', arguments: '{"pattern":"*.js"}' },
        { type: 'tool-call', id: 'call_2', name: 'glob', arguments: '{"pattern":"package.json"}' },
        { type: 'tool-call', id: 'call_3', name: 'read', arguments: '{"path":"package.json"}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'No files found' }], isError: false }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'No files found' }], isError: false }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_3', content: [{ type: 'text', text: '{"version":"0.1.4"}' }], isError: false }] },
    ],
    tools: [{ name: 'glob' }, { name: 'read' }, { name: 'gemini_web_search' }],
  }, 4)
  assert.equal(withEvidence.tools.length, 3)
})

test('registers Gemini native search with provider-valid JSON Schema', () => {
  const registered = []
  apply({
    llm: { registerAdapter: () => () => {} },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    effect: () => () => {},
    get: () => undefined,
  })
  const search = registered.find((tool) => tool.name === 'gemini_web_search')
  assert.deepEqual(search.parameters, {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'One precise web lookup request. Include complete URLs and exact identifiers when available.' },
    },
  })
  assert.deepEqual(search.output.schema.required, ['text', 'sources', 'supports', 'model', 'query', 'googleSearch', 'urlContext'])
})

test('Gemini native lookup enables Google Search and URL Context together', async () => {
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'grounded result' }] },
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://example.com/direct', title: 'Direct page' }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.net/report', title: 'Independent report' } },
            { web: { uri: 'https://example.com/direct', title: 'Duplicate direct page' } },
          ],
          groundingSupports: [{
            segment: { text: 'The directly supported claim.' },
            groundingChunkIndices: [0, 1],
          }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await runNativeWebLookup({
      baseURL: 'http://127.0.0.1:8080',
      searchModel: 'gemini-search-lite',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, 'https://github.com/example/provider', undefined)
    assert.deepEqual(captured.body.tools, [{ googleSearch: {} }, { urlContext: {} }])
    assert.match(captured.url, /gemini-search-lite:generateContent$/)
    assert.match(captured.body.contents[0].parts[0].text, /Copy source URLs exactly/)
    assert.match(captured.body.contents[0].parts[0].text, /must actually invoke Google Search/)
    assert.match(captured.body.contents[0].parts[0].text, /do not answer from model memory/)
    assert.match(captured.body.contents[0].parts[0].text, /partial, conflicting, or unsupported leads/)
    assert.match(captured.body.contents[0].parts[0].text, /Runtime date anchor: \d{4}-\d{2}-\d{2}/)
    assert.match(captured.body.contents[0].parts[0].text, /state the absolute date range used/)
    assert.equal(result.text, 'grounded result')
    assert.deepEqual(result.sources, [
      { uri: 'https://example.com/direct', title: 'Direct page', kind: 'url_context' },
      { uri: 'https://example.net/report', title: 'Independent report', kind: 'google_search' },
    ])
    assert.deepEqual(result.supports, [{
      claim: 'The directly supported claim.',
      sourceUris: ['https://example.net/report', 'https://example.com/direct'],
    }])
    assert.equal(result.urlContext, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('plain native web research uses Google Search without empty URL Context', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody
  let capturedUrl
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url)
    capturedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'grounded search result' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/news', title: 'News' } }] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await runNativeWebLookup({
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, 'latest semiconductor news', undefined, 'gemini-user-selected')
    assert.deepEqual(capturedBody.tools, [{ googleSearch: {} }])
    assert.match(capturedUrl, /gemini-user-selected:generateContent$/)
    assert.equal(result.model, 'gemini-user-selected')
    assert.equal(result.urlContext, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects an empty Gemini native lookup before producing non-lossless output', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('not expected')
  }
  try {
    await assert.rejects(
      runNativeWebLookup({ resolveApiKey: async () => 'test-key' }, undefined, undefined),
      (error) => error?.code === 'INVALID_ARGS' && /non-empty query/.test(error.message),
    )
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects native lookup text that has no provider grounding URLs', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'plausible but ungrounded result' }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      runNativeWebLookup({
        baseURL: 'http://127.0.0.1:8080',
        models: ['gemini-test'],
        resolveApiKey: async () => 'test-key',
      }, 'verify a current claim', undefined),
      /without grounding source URLs/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('falls back once when the preferred search model returns ungrounded text', async () => {
  const originalFetch = globalThis.fetch
  const requestedModels = []
  globalThis.fetch = async (url) => {
    requestedModels.push(decodeURIComponent(String(url).match(/models\/([^:]+):generateContent/)?.[1] ?? ''))
    if (requestedModels.length === 1) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'fast but ungrounded' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'grounded fallback' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org/source', title: 'Source' } }] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await runNativeWebLookup({
      baseURL: 'http://127.0.0.1:8080',
      searchModel: 'gemini-fast',
      searchFallbackModel: 'gemini-grounded',
      resolveApiKey: async () => 'test-key',
    }, 'verify a current claim', undefined)
    assert.deepEqual(requestedModels, ['gemini-fast', 'gemini-grounded'])
    assert.equal(result.model, 'gemini-grounded')
    assert.equal(result.sources[0].uri, 'https://example.org/source')
  } finally {
    globalThis.fetch = originalFetch
  }
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

test('emits a strict native text and reasoning stream and consumes the final SSE line', async () => {
  const payload = JSON.stringify({
    candidates: [{
      content: { parts: [{ thought: true, text: 'reasoning' }, { text: 'answer' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
  })
  const response = streamResponse(['data: ', payload.slice(0, 25), payload.slice(25)])
  const { chunks } = await collectMockedStream(response, {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })

  validateStrictStream(chunks)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => [chunk.index, chunk.blockType]), [[1, 'reasoning'], [0, 'text']])
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === 1).block.text, 'reasoning')
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === 0).block.text, 'answer')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('emits strict OpenAI text, reasoning, and fragmented tool-call blocks with unique indexes', async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: 'think', content: 'checking' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'README.md"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ]
  const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]'
  const { chunks } = await collectMockedStream(streamResponse([sse.slice(0, 17), sse.slice(17, 83), sse.slice(83)]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
  })

  validateStrictStream(chunks)
  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.deepEqual(new Set(starts.map((chunk) => chunk.index)).size, starts.length)
  const tool = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(tool.block, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('applies runtime sandbox and glob repairs through the streaming adapter', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_write', function: { name: 'write', arguments: '{"file_path":"note.txt","content":"ok","sandbox_permissions":"workspace-write","justification":"write"}' } },
      { index: 1, id: 'call_grep', function: { name: 'grep', arguments: '{"pattern":"TODO","include":"*.js, *.ts"}' } },
    ] }, finish_reason: 'tool_calls' }] },
  ]
  const { chunks } = await collectMockedStream(streamResponse([`data: ${JSON.stringify(events[0])}\n\ndata: [DONE]\n\n`]), {
    model: 'gemini-test',
    system: 'Current DSH file policy: workspace-write',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'write and search' }] }],
    tools: [
      { name: 'write', parameters: { type: 'object' } },
      { name: 'grep', parameters: { type: 'object', properties: { include: { type: 'string', description: 'One glob filter. Not a list.' } } } },
    ],
  })

  const calls = chunks
    .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    .map((chunk) => chunk.block)
  assert.deepEqual(calls, [
    { type: 'tool-call', id: 'call_write', name: 'write', arguments: '{"file_path":"note.txt","content":"ok"}' },
    { type: 'tool-call', id: 'call_grep', name: 'grep', arguments: '{"pattern":"TODO","include":"{*.js,*.ts}"}' },
  ])
})

test('reclassifies fragmented internal runtime echoes as reasoning instead of answer text', async () => {
  const events = [
    { choices: [{ delta: { content: 'A' } }] },
    { choices: [{ delta: { content: ' previously requested tool execution completed.\nTool: write\nResult:\n(no output)' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
  const { chunks } = await collectMockedStream(streamResponse([
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
  ]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'finish the task' }] }],
    tools: [{ name: 'write', parameters: { type: 'object' } }],
  })

  validateStrictStream(chunks)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), false)
  const reasoning = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.match(reasoning.block.text, /^A previously requested tool execution completed\./)
})

test('does not delay or reclassify ordinary answer text after its prefix diverges', async () => {
  const events = [
    { choices: [{ delta: { content: 'A useful' } }] },
    { choices: [{ delta: { content: ' answer' }, finish_reason: 'stop' }] },
  ]
  const { chunks } = await collectMockedStream(streamResponse([
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  ]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'answer normally' }] }],
    tools: [{ name: 'read', parameters: { type: 'object' } }],
  })

  validateStrictStream(chunks)
  const text = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(text.block.text, 'A useful answer')
})

test('separates complete tool calls when an older proxy omits stream indexes', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ id: 'call_todo', function: { name: 'todo_write', arguments: '{"todos":[]}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'call_read', function: { name: 'read', arguments: '{"file_path":"README.md"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]
  const { chunks } = await collectMockedStream(streamResponse([events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'use two tools' }] }],
    tools: [{ name: 'read', parameters: { type: 'object' } }],
  })

  validateStrictStream(chunks)
  const calls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block)
  assert.deepEqual(calls, [
    { type: 'tool-call', id: 'call_todo', name: 'todo_write', arguments: '{"todos":[]}' },
    { type: 'tool-call', id: 'call_read', name: 'read', arguments: '{"file_path":"README.md"}' },
  ])
})

test('emits at most one Gemini native search call per model response', async () => {
  const event = {
    choices: [{ delta: { tool_calls: [
      { index: 0, id: 'search_1', function: { name: 'gemini_web_search', arguments: '{"query":"first"}' } },
      { index: 1, id: 'search_2', function: { name: 'gemini_web_search', arguments: '{"query":"near duplicate"}' } },
    ] }, finish_reason: 'tool_calls' }],
  }
  const { chunks } = await collectMockedStream(streamResponse([`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'verify current news' }] }],
    tools: [{ name: 'gemini_web_search', parameters: { type: 'object' } }],
  })

  validateStrictStream(chunks)
  const calls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'search_1')
  assert.equal(calls[0].name, 'gemini_web_search')
  const query = JSON.parse(calls[0].arguments).query
  assert.match(query, /^first/)
  assert.match(query, /Relative-time wording from the user: "current"/)
  assert.doesNotMatch(query, /Exact requested rolling window/)
})

test('preserves native function-call thought signatures without swallowing conversion errors', async () => {
  const payload = JSON.stringify({
    candidates: [{
      content: { parts: [{ functionCall: { id: 'native_1', name: 'read', args: { path: 'README.md' }, thoughtSignature: 'sig-native' } }] },
      finishReason: 'STOP',
    }],
  })
  const adapter = adapterForStream()
  const { chunks } = await collectMockedStream(streamResponse([`data: ${payload}\n\n`]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
  }, adapter)

  validateStrictStream(chunks)
  assert.equal(adapter.callSignatures.get('native_1'), 'sig-native')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('reports a completed empty provider response as an explicit error finish', async () => {
  const payload = JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })
  const { chunks } = await collectMockedStream(streamResponse([`data: ${payload}\n\n`]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })

  validateStrictStream(chunks)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
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
