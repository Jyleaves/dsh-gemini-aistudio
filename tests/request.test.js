import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGeminiRequest, buildOpenAIRequest, sanitizeToolSchema } from '../lib/request.js'
import { GeminiAdapter, apply, collectPriorClaimVerifications, collectPriorSearchSources, compactResearchFinalText, normalizeToolArguments, prepareAgentExecution, prepareSearchConvergence, reasoningMetadata, renderNativeWebLookup, researchArtifactState, runNativeClaimVerification, runNativeWebLookup, shouldUseOpenAICompatibility } from '../lib/index.js'

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

test('blocks shell-based external web fallback only after Gemini native search failed', () => {
  const blocked = normalizeToolArguments(
    'pwsh',
    { command: 'python -c "import urllib.request; print(urllib.request.urlopen(\'https://example.com\').read())"' },
    undefined,
    { blockExternalWebFallback: true },
  )
  assert.match(blocked.command, /External web fallback through PowerShell is disabled/)
  assert.match(blocked.description, /Block external web fallback/)

  assert.equal(
    normalizeToolArguments('pwsh', '{"command":"Get-Content README.md"}', undefined, { blockExternalWebFallback: true }),
    '{"command":"Get-Content README.md","description":"Run PowerShell command"}',
  )
  assert.equal(
    normalizeToolArguments('pwsh', '{"command":"Invoke-RestMethod http://127.0.0.1:8080/health"}', undefined, { blockExternalWebFallback: true }),
    '{"command":"Invoke-RestMethod http://127.0.0.1:8080/health","description":"Run PowerShell command"}',
  )
})

test('removes edit-only fields from update_goal completion calls', () => {
  assert.equal(
    normalizeToolArguments('update_goal', '{"action":"complete","goal_id":"goal-1","revision":2,"objective":"repeat","max_goal_rounds":5}'),
    '{"action":"complete","goal_id":"goal-1","revision":2}',
  )
  assert.equal(
    normalizeToolArguments('update_goal', '{"action":"edit","goal_id":"goal-1","revision":2,"objective":"revised","max_goal_rounds":6}'),
    '{"action":"edit","goal_id":"goal-1","revision":2,"objective":"revised","max_goal_rounds":6}',
  )
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

test('repairs numeric arguments to explicit JSON Schema bounds', () => {
  const schema = {
    type: 'object',
    properties: {
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', exclusiveMinimum: 0, maximum: 2000 },
    },
  }
  assert.equal(
    normalizeToolArguments('read', '{"offset":0,"limit":5000}', schema),
    '{"offset":1,"limit":2000}',
  )
  assert.equal(
    normalizeToolArguments('read', '{"offset":"0","limit":"20"}', schema),
    '{"offset":1,"limit":20}',
  )
})

test('preserves parent numeric bounds when a nullable parameter uses anyOf', () => {
  const schema = {
    type: 'object',
    properties: {
      offset: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        minimum: 1,
      },
    },
  }
  assert.equal(
    normalizeToolArguments('read', '{"offset":0}', schema),
    '{"offset":1}',
  )
  assert.equal(
    normalizeToolArguments('read', '{"offset":null}', schema),
    '{"offset":null}',
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

test('drops incomplete required objects from arbitrary tool arrays', () => {
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
      todos: [
        { content: 'Inspect logs', status: 'completed' },
        { status: 'pending' },
        { content: 'Run tests' },
        null,
      ],
    }, schema),
    { todos: [{ content: 'Inspect logs', status: 'completed' }] },
  )
})

test('decodes a double-escaped strict JSON document before a write call', () => {
  const escaped = '[\\n  {\\"name\\": \\"alpha\\", \\"score\\": null}\\n]'
  assert.equal(
    normalizeToolArguments('write', JSON.stringify({ file_path: 'report.json', content: escaped })),
    JSON.stringify({ file_path: 'report.json', content: '[\n  {"name": "alpha", "score": null}\n]' }),
  )
  const valid = '{"message":"line one\\nline two"}'
  assert.equal(
    normalizeToolArguments('write', JSON.stringify({ file_path: 'report.json', content: valid })),
    JSON.stringify({ file_path: 'report.json', content: valid }),
  )
  assert.equal(
    normalizeToolArguments('write', JSON.stringify({ file_path: 'report.txt', content: escaped })),
    JSON.stringify({ file_path: 'report.txt', content: escaped }),
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
      todos: [
        { content: 'Collect sources', status: 'in_progressghost' },
        { content: 'Write report', status: 'completedhidden' },
        { content: 'Verify report', status: 'completed grandson' },
      ],
    }, schema),
    {
      todos: [
        { content: 'Collect sources', status: 'in_progress' },
        { content: 'Write report', status: 'completed' },
        { content: 'Verify report', status: 'completed' },
      ],
    },
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

test('does not replay private reasoning into later Gemini requests', async () => {
  const options = {
    model: 'gemini-3.7-flash',
    messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'private analysis' }, { type: 'text', text: 'visible answer' }] }],
  }
  const native = await buildGeminiRequest(options, { googleSearch: false })
  const openai = await buildOpenAIRequest(options, {})

  assert.deepEqual(native.contents[0].parts, [{ text: 'visible answer' }])
  assert.equal('reasoning_content' in openai.messages[0], false)
  assert.equal(openai.messages[0].content, 'visible answer')
})

test('adds general agent continuation guidance whenever tools are available', () => {
  const prepared = prepareAgentExecution({ system: 'base', tools: [{ name: 'read' }] })
  assert.match(prepared.system, /call that tool instead of ending the turn with a plan/)
  assert.match(prepared.system, /Keep private analysis and reasoning out of normal answer text/)
  assert.match(prepared.system, /check the supplied JSON Schema/)
  assert.match(prepared.system, /failed tool result is not progress/)
  assert.match(prepared.system, /File existence alone proves neither content quality nor format correctness/)
  assert.match(prepared.system, /subagent identifier is not a background-job identifier/)
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
  assert.match(prepared.system, /Ignore hidden caches, dependency trees, generated artifacts, and binaries/)
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

test('requires fresh claim verification after every new grounded lookup before research writes', () => {
  const tools = [
    { name: 'gemini_web_search', parameters: { type: 'object' } },
    { name: 'gemini_verify_claims', parameters: { type: 'object' } },
    { name: 'write', parameters: { type: 'object' } },
    { name: 'edit', parameters: { type: 'object' } },
    { name: 'read', parameters: { type: 'object' } },
  ]
  const start = [
    { role: 'user', content: [{ type: 'text', text: '请核实事实并写一份研究报告' }] },
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
    { role: 'user', content: [{ type: 'text', text: '<skill_content name="research-writer">Expanded internal skill instructions.</skill_content>' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'search-1', name: 'gemini_web_search', arguments: '{"query":"official data"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'search-1', content: [{ type: 'text', text: 'Grounded evidence packet with enough substantive source material and exact URLs.' }], isError: false }] },
  ]
  const afterSearch = prepareSearchConvergence({ messages: start, tools })
  assert.equal(afterSearch.tools.some((tool) => tool.name === 'write'), false)
  assert.equal(afterSearch.tools.some((tool) => tool.name === 'edit'), false)
  assert.equal(afterSearch.tools.some((tool) => tool.name === 'gemini_verify_claims'), true)
  assert.match(afterSearch.system, /newer than the latest successful gemini_verify_claims result/)

  const afterVerification = prepareSearchConvergence({
    messages: [
      ...start,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-1', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-1', content: [{ type: 'text', text: 'Claim verification evidence packet with a successful supported result.' }], isError: false }] },
    ],
    tools,
  })
  assert.equal(afterVerification.tools.some((tool) => tool.name === 'write'), true)
  assert.equal(afterVerification.tools.some((tool) => tool.name === 'edit'), true)

  const longDraft = `# Research report\n\n${'A material externally checkable research claim with dates, quantities, institutions, policies, and outcomes. '.repeat(20)}`
  const afterDraftWrite = prepareSearchConvergence({
    messages: [
      ...start,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-1', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-1', content: [{ type: 'text', text: 'Claim verification evidence packet with a successful supported result.' }], isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'write-1', name: 'write', arguments: JSON.stringify({ file_path: 'report.md', content: longDraft }) }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-1', content: [{ type: 'text', text: 'Wrote report.md successfully.' }], isError: false }] },
    ],
    tools,
  })
  assert.equal(afterDraftWrite.tools.some((tool) => tool.name === 'write'), false)
  assert.equal(afterDraftWrite.tools.some((tool) => tool.name === 'edit'), false)
  assert.equal(afterDraftWrite.tools.some((tool) => tool.name === 'gemini_verify_claims'), true)
  assert.match(afterDraftWrite.system, /long research draft was written/)
  assert.match(afterDraftWrite.system, /complete inventory of material claims actually present in that draft/)

  const afterPostDraftEdit = prepareSearchConvergence({
    messages: [
      ...start,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-1', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-1', content: [{ type: 'text', text: 'Claim verification evidence packet with a successful supported result.' }], isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'write-1', name: 'write', arguments: JSON.stringify({ file_path: 'report.md', content: longDraft }) }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-1', content: [{ type: 'text', text: 'Wrote report.md successfully.' }], isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-2', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-2', content: [{ type: 'text', text: 'Claim verification evidence packet with a second successful result.' }], isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: 'outputs/final/report.md', old_string: '99 tonnes', new_string: 'the supported amount' }) }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'edit-1', content: [{ type: 'text', text: 'Edited outputs/final/report.md successfully.' }], isError: false }] },
    ],
    tools,
  })
  assert.equal(afterPostDraftEdit.tools.some((tool) => tool.name === 'write'), false)
  assert.equal(afterPostDraftEdit.tools.some((tool) => tool.name === 'edit'), false)
  assert.equal(afterPostDraftEdit.tools.some((tool) => tool.name === 'gemini_verify_claims'), true)
  assert.match(afterPostDraftEdit.system, /long research draft was written/)

  const afterNewSearch = prepareSearchConvergence({
    messages: [
      ...start,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-1', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-1', content: [{ type: 'text', text: 'Claim verification evidence packet with a successful supported result.' }], isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'search-2', name: 'gemini_web_search', arguments: '{"query":"different precise number"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'search-2', content: [{ type: 'text', text: 'A different grounded evidence packet with a newly discovered precise value.' }], isError: false }] },
    ],
    tools,
  })
  assert.equal(afterNewSearch.tools.some((tool) => tool.name === 'write'), false)
  assert.equal(afterNewSearch.tools.some((tool) => tool.name === 'edit'), false)
})

test('requires a separate fact-check artifact before research goal completion', () => {
  const packet = [
    'Claim verification evidence packet',
    '',
    'Sources (citation whitelist; copy URLs exactly):',
    '[S1] https://official.example/report — Official report [url_context]',
    '',
    'Verification outcomes:',
    '[V1] PARTIAL: The report supports only the date.',
    '  Sources: S1',
  ].join('\n')
  const longDraft = `# Research report\n\n${'A material claim with dates, quantities, institutions, and outcomes. '.repeat(30)}`
  const base = [
    { role: 'user', content: [{ type: 'text', text: '查最新情况，写一篇研究性文章' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-1', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-1', content: [{ type: 'text', text: packet }], isError: false }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'write-report', name: 'write', arguments: JSON.stringify({ file_path: 'outputs/report.md', content: longDraft }) }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-report', content: [{ type: 'text', text: 'Wrote outputs/report.md.' }], isError: false }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-2', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-2', content: [{ type: 'text', text: packet }], isError: false }] },
  ]
  const tools = [
    { name: 'gemini_web_search', parameters: { type: 'object' } },
    { name: 'gemini_verify_claims', parameters: { type: 'object' } },
    { name: 'write', parameters: { type: 'object' } },
    { name: 'update_goal', parameters: { type: 'object' } },
  ]
  const artifacts = researchArtifactState(base)
  assert.equal(artifacts.hasLongDraft, true)
  assert.equal(artifacts.hasFactCheckArtifact, false)

  const pending = prepareSearchConvergence({ messages: base, tools })
  assert.equal(pending.tools.some((tool) => tool.name === 'write'), true)
  assert.equal(pending.tools.some((tool) => tool.name === 'update_goal'), false)
  assert.match(pending.system, /no separate fact-check artifact/)

  const factCheck = '# 事实核查表\n\n| 编号 | 状态 | 事实 | 来源 |\n|---|---|---|---|\n| V1 | PARTIAL | The report supports only the date. | https://official.example/report |'
  const completeMessages = [
    ...base,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'write-facts', name: 'write', arguments: JSON.stringify({ file_path: 'outputs/report-fact-check.md', content: factCheck }) }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-facts', content: [{ type: 'text', text: 'Wrote outputs/report-fact-check.md.' }], isError: false }] },
  ]
  assert.equal(researchArtifactState(completeMessages).hasFactCheckArtifact, true)
  const complete = prepareSearchConvergence({ messages: completeMessages, tools })
  assert.equal(complete.tools.some((tool) => tool.name === 'update_goal'), true)
})

test('compacts long research finals and reports incomplete artifact state honestly', () => {
  const raw = [
    '已完成研究报告。',
    '`outputs/report.docx`',
    '`outputs/report.md`',
    '# 研究报告正文',
    '正文'.repeat(2_000),
    '# 事实核查表',
    '好的，我已经理解您的需求。<execute_bash>旧任务计划</execute_bash>',
  ].join('\n\n')
  const compact = compactResearchFinalText(raw, {
    artifacts: { hasLongDraft: true, hasFactCheckArtifact: false, draftPaths: ['outputs/report.md'], factCheckPaths: [] },
    verifications: [{ status: 'VERIFIED' }, { status: 'PARTIAL' }],
  })
  assert.match(compact, /独立事实核查表尚未成功写入文件/)
  assert.match(compact, /outputs\/report\.docx/)
  assert.match(compact, /VERIFIED 1 条，PARTIAL 1 条/)
  assert.doesNotMatch(compact, /execute_bash|研究报告正文/)
  assert.ok(compact.length < 1_000)
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

test('suppresses pwsh after one blocked external web fallback', () => {
  const prepared = prepareSearchConvergence({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '核实最近消息' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'shell-1', name: 'pwsh', arguments: '{"command":"throw ..."}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'shell-1', content: [{ type: 'text', text: 'External web fallback through PowerShell is disabled after Gemini native search failed.' }], isError: true }] },
    ],
    tools: [
      { name: 'pwsh', parameters: { type: 'object' } },
      { name: 'read', parameters: { type: 'object' } },
    ],
  })
  assert.deepEqual(prepared.tools.map((tool) => tool.name), ['read'])
  assert.match(prepared.system, /not a substitute for gemini_web_search/)
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

test('anchors Chinese 最近 N 天 phrasing to an exact rolling window', () => {
  const raw = normalizeToolArguments(
    'gemini_web_search',
    '{"query":"AI chip news"}',
    undefined,
    {
      latestUserText: '最近两天有什么重要消息？',
      now: new Date(2026, 7, 26, 12, 0, 0),
    },
  )
  const query = JSON.parse(raw).query
  assert.match(query, /Exact requested rolling window for "最近两天": 2026-08-24/)
  assert.match(query, /through 2026-08-26/)
})

test('does not let plugin role-user injections replace the human temporal request', () => {
  const prepared = prepareSearchConvergence({
    messages: [
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '最近两天有什么重要消息？' }],
      },
      {
        role: 'user',
        source: { kind: 'skill-catalog' },
        content: [{ type: 'text', text: 'Search latest recent current information.' }],
      },
    ],
    tools: [{ name: 'gemini_web_search', parameters: { type: 'object' } }],
  }, 6, new Date(2026, 7, 26, 12, 0, 0))
  assert.match(prepared.system, /Exact requested rolling window for "最近两天": 2026-08-24/)
  assert.doesNotMatch(prepared.system, /Exact requested rolling window for "latest"/)
})

test('reuses a uniquely referenced prior source URL for URL Context without target hardcoding', async () => {
  const adapter = new GeminiAdapter({
    baseURL: 'http://127.0.0.1:8080',
    provider: 'aistudio-gemini',
    resolveApiKey: async () => 'test-key',
    models: ['gemini-test'],
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"audit-1","function":{"name":"gemini_web_search","arguments":"{\\"query\\":\\"verify prior source\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    const priorUrl = 'https://example.test/canonical-report'
    const options = {
      model: 'gemini-test',
      tools: [{
        name: 'gemini_web_search',
        parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      }],
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Find two reports' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'search-1', name: 'gemini_web_search', arguments: '{"query":"reports"}' }] },
        { role: 'user', source: { kind: 'tool' }, content: [{
          type: 'tool-result',
          toolCallId: 'search-1',
          content: [{ type: 'text', text: `Exact URLs returned by provider grounding metadata (copy verbatim):\n1. ${priorUrl} — Example Labs [google_search]\n2. https://other.test/news — Other News [google_search]` }],
          isError: false,
        }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请直接核对刚才的 Example Labs 来源页面' }] },
        { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'runtime injection' }] },
      ],
    }
    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    const call = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')?.block
    assert.match(call.arguments, /https:\/\/example\.test\/canonical-report/)
    assert.doesNotMatch(call.arguments, /https:\/\/other\.test\/news/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('collects exact grounded source URLs across every prior lookup in the turn', () => {
  const messages = [
    { role: 'user', content: [{
      type: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: 'Exact URLs returned by provider grounding metadata (copy verbatim):\n1. https://one.example/report — First report [google_search]' }],
    }] },
    { role: 'user', content: [{
      type: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: 'Grounded evidence packet\n\nSources (citation whitelist; copy URLs exactly):\n[S1] https://two.example/news — Second report [url_context]\n[S2] https://one.example/report — Duplicate [google_search]' }],
    }] },
  ]
  assert.deepEqual(collectPriorSearchSources(messages), [
    { uri: 'https://one.example/report', title: 'First report' },
    { uri: 'https://two.example/news', title: 'Second report' },
  ])
})

test('prevents research file writes from inventing citation URLs', () => {
  const normalized = JSON.parse(normalizeToolArguments(
    'write',
    JSON.stringify({
      file_path: 'report.md',
      content: '[grounded](https://official.example/report) [invented](https://official.example/report/fake-slug)',
    }),
    undefined,
    {
      latestUserText: '请核查事实并写一份研究报告',
      priorSearchSources: [{ uri: 'https://official.example/report', title: 'Official report' }],
    },
  ))
  assert.match(normalized.content, /https:\/\/official\.example\/report/)
  assert.doesNotMatch(normalized.content, /fake-slug/)
  assert.match(normalized.content, /\[unverified URL omitted\]/)
})

test('downgrades verified labels when a fact-check write uses non-whitelisted URLs', () => {
  const normalized = JSON.parse(normalizeToolArguments(
    'write',
    JSON.stringify({
      file_path: 'fact-check.md',
      content: '# 事实核查表\n| 事实 | 来源 | 状态 |\n|---|---|---|\n| 示例 | https://invented.example/home | 已核（精确支持） |\n\n全部事实验证通过。',
    }),
    undefined,
    {
      latestUserText: '请核查事实并写一份研究报告',
      priorSearchSources: [{ uri: 'https://official.example/report', title: 'Official report' }],
    },
  ))
  assert.match(normalized.content, /\[unverified URL omitted\]/)
  assert.match(normalized.content, /待核（来源 URL 未通过白名单）/)
  assert.match(normalized.content, /不能认定全部事实验证通过/)
  assert.doesNotMatch(normalized.content, /\| 已核/)
})

test('collects the latest structured claim-verification statuses and exact URLs', () => {
  const packet = `Claim verification evidence packet

Sources (citation whitelist; copy URLs exactly):
[S1] https://official.example/one — First source [url_context]
[S2] https://official.example/two — Second source [url_context]

Verification outcomes:
[V1] VERIFIED: The project opened on 1 May.
  Sources: S1
  Provider: V1 VERIFIED
[V2] PARTIAL: The platform opened on 2 May and produced 99 tonnes.
  Sources: S2
  Provider: V2 PARTIAL: the opening date is supported but the output is not.`
  const messages = [{ role: 'user', content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: packet }] }] }]
  assert.deepEqual(collectPriorClaimVerifications(messages), [
    { id: 'V1', status: 'VERIFIED', claim: 'The project opened on 1 May.', sourceUrls: ['https://official.example/one'] },
    { id: 'V2', status: 'PARTIAL', claim: 'The platform opened on 2 May and produced 99 tonnes.', sourceUrls: ['https://official.example/two'] },
  ])
})

test('prevents a fact-check table from laundering partial or unsubmitted claims as verified', () => {
  const priorClaimVerifications = [
    { id: 'V1', status: 'VERIFIED', claim: 'The project opened on 1 May.', sourceUrls: ['https://official.example/one'] },
    { id: 'V2', status: 'PARTIAL', claim: 'The platform opened on 2 May and produced 99 tonnes.', sourceUrls: ['https://official.example/two'] },
    { id: 'V3', status: 'UNSUPPORTED', claim: 'The equipment reduced costs by 35 percent.', sourceUrls: ['https://official.example/three'] },
  ]
  const normalized = JSON.parse(normalizeToolArguments(
    'write',
    JSON.stringify({
      file_path: 'fact-check.md',
      content: '# 事实核查表\n\n所有引用事实均为**已核（VERIFIED）**，不存在无法追溯的数据。\n\n| 事实 | 状态 | 结论 | 来源 |\n|---|---|---|---|\n| The project opened on 1 May. | **VERIFIED / 已核** | **精确支持。** | https://official.example/one |\n| The platform opened on 2 May and produced 99 tonnes. | **VERIFIED / 已核** | **精确支持。** | https://official.example/two |\n| An unrelated forecast says revenue will double. | **VERIFIED / 已核** | **精准支持。** | https://official.example/one |',
    }),
    undefined,
    {
      latestUserText: 'Write a research report with a fact-check table.',
      priorSearchSources: priorClaimVerifications.flatMap((item) => item.sourceUrls.map((uri) => ({ uri, title: '' }))),
      priorClaimVerifications,
    },
  ))
  assert.match(normalized.content, /The project opened on 1 May\. \| \*\*VERIFIED/)
  assert.match(normalized.content, /The platform opened on 2 May.*PARTIAL（仅部分支持/)
  assert.match(normalized.content, /unrelated forecast.*UNVERIFIED（未提交严格核验/)
  assert.doesNotMatch(normalized.content, /PARTIAL（仅部分支持[^\n]*\/\*\*PARTIAL/)
  assert.doesNotMatch(normalized.content, /The platform opened on 2 May[^\n]*(?:精确|精准)支持/)
  assert.doesNotMatch(normalized.content, /unrelated forecast[^\n]*(?:精确|精准)支持/)
  assert.match(normalized.content, /未提交 `gemini_verify_claims` 严格核验/)
  assert.doesNotMatch(normalized.content, /所有引用事实均为\*\*已核/)
  assert.match(normalized.content, /适配器严格核验结果（自动审计）/)
  assert.match(normalized.content, /\| V3 \| UNSUPPORTED \| The equipment reduced costs by 35 percent\./)
  assert.match(normalized.content, /https:\/\/official\.example\/three/)
})

test('maps translated fact-check rows by verification number and exact URL', () => {
  const normalized = JSON.parse(normalizeToolArguments(
    'write',
    JSON.stringify({
      file_path: 'fact-check.md',
      content: '# 事实核查表\n\n| 序号 | 事实 | 状态 | 来源 |\n|---|---|---|---|\n| 1 | 该项目于5月1日正式开放。 | **UNVERIFIED（未提交严格核验）** | https://official.example/one |',
    }),
    undefined,
    {
      latestUserText: '请核查事实并写一份研究报告',
      priorSearchSources: [{ uri: 'https://official.example/one', title: '' }],
      priorClaimVerifications: [
        { id: 'V1', status: 'VERIFIED', claim: 'The project opened on 1 May.', sourceUrls: ['https://official.example/one'] },
      ],
    },
  ))
  assert.match(normalized.content, /该项目于5月1日正式开放。 \| \*\*VERIFIED \/ 已核\*\*/)
  assert.doesNotMatch(normalized.content, /UNVERIFIED（未提交严格核验）/)
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
  const verifier = registered.find((tool) => tool.name === 'gemini_verify_claims')
  assert.deepEqual(search.parameters, {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'One precise web lookup request. Include complete URLs and exact identifiers when available.' },
    },
  })
  assert.deepEqual(search.output.schema.required, ['text', 'sources', 'supports', 'model', 'query', 'googleSearch', 'urlContext'])
  assert.equal(search.timeoutMs, 240_000)
  const rendered = search.output.render(null, {
    text: 'candidate result',
    query: 'news\nExact requested rolling window for "最近两天": 2026-08-24 12:00:00 through 2026-08-26 12:00:00.',
    sources: [{ uri: 'https://example.test/news', title: 'News', kind: 'google_search' }],
    supports: [],
  })[0].text
  assert.match(rendered, /Temporal acceptance gate/)
  assert.match(rendered, /Omit every out-of-window item/)
  assert.match(rendered, /2026-08-24.*through 2026-08-26/)
  assert.deepEqual(verifier.parameters.required, ['claims'])
  assert.deepEqual(verifier.parameters.properties.claims.items.required, ['claim', 'sourceUrls'])
  assert.deepEqual(verifier.output.schema.required, ['text', 'sources', 'supports', 'model', 'query', 'googleSearch', 'urlContext', 'requestedClaims', 'verifications'])
  assert.deepEqual(verifier.output.schema.properties.sources.items.required, ['uri', 'title', 'kind'])
  assert.deepEqual(verifier.output.schema.properties.requestedClaims.items.required, ['id', 'claim', 'sourceUrls'])
  assert.deepEqual(verifier.output.schema.properties.verifications.items.required, ['id', 'claim', 'sourceUrls', 'status', 'details'])
  assert.equal(verifier.timeoutMs, 900_000)
})

test('shares newly grounded sources with claim verification in the same live agent', async () => {
  const registered = []
  apply({
    llm: { registerAdapter: () => () => {} },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    effect: () => () => {},
    get: (name) => name === 'credentials'
      ? { resolve: async () => ({ value: 'test-key' }) }
      : undefined,
  }, { baseURL: 'http://127.0.0.1:8080', models: ['gemini-selected'] })
  const search = registered.find((tool) => tool.name === 'gemini_web_search')
  const verifier = registered.find((tool) => tool.name === 'gemini_verify_claims')
  const sourceUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token='
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls += 1
    const verification = JSON.parse(init.body).tools?.some((tool) => tool.urlContext)
      && !JSON.parse(init.body).tools?.some((tool) => tool.googleSearch)
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: verification ? 'V1 VERIFIED' : 'Grounded result' }] },
        ...(verification
          ? { urlContextMetadata: { urlMetadata: [{ retrievedUrl: sourceUrl, title: 'Official report' }] } }
          : { groundingMetadata: { groundingChunks: [{ web: { uri: sourceUrl, title: 'Official report' } }] } }),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const agent = { options: { model: 'gemini-selected', messages: [] } }
    await search.execute({ query: 'find the official report' }, { agent, signal: undefined })
    const verified = await verifier.execute({
      claims: [{ claim: 'The report states 42.', sourceUrls: [sourceUrl] }],
    }, { agent, signal: undefined })
    assert.equal(calls, 2)
    assert.equal(verified.text, 'V1 VERIFIED')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('renders compact source and claim evidence without repeating long provider prose', () => {
  const raw = 'A'.repeat(20_000)
  const rendered = renderNativeWebLookup({
    text: raw,
    query: 'verify current facts',
    sources: [{ uri: 'https://example.test/report', title: 'Official report', kind: 'google_search' }],
    supports: [{ claim: 'The report directly supports this claim.', sourceUris: ['https://example.test/report'] }],
  })[0].text
  assert.match(rendered, /\[S1\] https:\/\/example\.test\/report/)
  assert.match(rendered, /\[C1\] The report directly supports this claim/)
  assert.doesNotMatch(rendered, new RegExp(raw.slice(0, 100)))
  assert.ok(rendered.length < 5000)
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

test('claim verification reopens only prior grounded URLs with URL Context', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'V1 VERIFIED: the official page directly supports the claim.' }] },
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://official.example/report', title: 'Official report' }] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await runNativeClaimVerification({
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, [{ claim: 'The reported value is 42.', sourceUrls: ['https://official.example/report'] }], [
      { uri: 'https://official.example/report', title: 'Official report' },
    ], undefined, 'gemini-selected')
    assert.deepEqual(capturedBody.tools, [{ urlContext: {} }])
    assert.match(capturedBody.contents[0].parts[0].text, /Do not use Google Search/)
    assert.equal(result.googleSearch, false)
    assert.equal(result.urlContext, true)
    assert.deepEqual(result.requestedClaims, [{
      id: 'V1',
      claim: 'The reported value is 42.',
      sourceUrls: ['https://official.example/report'],
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('claim verification rejects a URL that was not returned by grounded search', async () => {
  await assert.rejects(
    runNativeClaimVerification({ resolveApiKey: async () => 'test-key' }, [{
      claim: 'A fabricated source supports this.',
      sourceUrls: ['https://invented.example/fake'],
    }], [{ uri: 'https://official.example/report' }], undefined, 'gemini-test'),
    (error) => error?.code === 'INVALID_ARGS' && /unknown URL/.test(error.message),
  )
})

test('claim verification repairs one missing character in a uniquely matching grounded redirect URL', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'V1 VERIFIED' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const prefix = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'
  const known = `${prefix}AUZIYQFA8vtshLi8ZOOu2QjDgn8RAXUr70LwlaPPCD6z82pcGk_DNfuLMiVVZeG0z`
  const missingCharacter = `${prefix}AUZIYFA8vtshLi8ZOOu2QjDgn8RAXUr70LwlaPPCD6z82pcGk_DNfuLMiVVZeG0z`
  try {
    const result = await runNativeClaimVerification({
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, [{ claim: 'The grounded page supports this claim.', sourceUrls: [missingCharacter] }], [
      { uri: known, title: 'Grounded report' },
    ], undefined, 'gemini-test')
    assert.match(capturedBody.contents[0].parts[0].text, new RegExp(known))
    assert.deepEqual(result.requestedClaims[0].sourceUrls, [known])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('claim verification repairs two streamed character corruptions only when the redirect match is unique', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '**V1**\nStatus: VERIFIED\nThe page directly supports the claim.' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const prefix = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'
  const known = `${prefix}AUZIYQGR_nwS1tk9bFa_RVL2_WokJxBcovuHKadxXS3TUvJF1Zx_ALZ5WWtzefTNOwUJPhgjDGByDY9WrWc-HitdvPc-9uZsuZe854fe0AK4Xe7KsUA3-YizAMq_MrlnxwfCOxDtkkzW65KB94Hba5w__h-h`
  const corrupted = `${prefix}AUZIYQGR_nwS1tk9bFa_RVL2_WokJxBcovuHKadxXS3TUvJF1Zx_ALZ5WWtzefTNOwUJPhgjDGByDY9WrWc-HitdvPc-9uZsuZe854fe0AK4Xe7KsUA3-YizAMq_MrlnwfwfCOxDtkkzW65KB94Hba5w__h-h`
  try {
    const result = await runNativeClaimVerification({
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, [{ claim: 'The grounded page supports this claim.', sourceUrls: [corrupted] }], [
      { uri: known, title: 'Grounded report' },
    ], undefined, 'gemini-test')
    assert.match(capturedBody.contents[0].parts[0].text, new RegExp(known))
    assert.deepEqual(result.requestedClaims[0].sourceUrls, [known])
    assert.equal(result.verifications[0].status, 'VERIFIED')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('claim verification strips streamed JSON leakage after a complete grounding token', async () => {
  const originalFetch = globalThis.fetch
  const exact = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFzwOLg4Nv05nPgZ2v5of5ovGBchUJkUBACFlTk1n0uWjfwRw4_NgGGMSwEkT6s3OWNh7kQdyVNSCtjZMYXOd2UX2agrmqf5CBoJ6waZJLefL0kDr8cjTuwCfW0r5tOty4x9_4='
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.match(body.contents[0].parts[0].text, new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(body.contents[0].parts[0].text, /\]\},\{claim:/)
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'V1 VERIFIED: supported' }] },
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: exact, title: 'Official source' }] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await runNativeClaimVerification(
      { baseURL: 'http://127.0.0.1:8080', resolveApiKey: async () => 'key', models: ['gemini-test'] },
      [{ claim: 'Supported claim', sourceUrls: [`${exact}\`]},{claim:`] }],
      [{ uri: exact, title: 'Official source' }],
      undefined,
      'gemini-test',
    )
    assert.equal(result.verifications[0].status, 'VERIFIED')
    assert.deepEqual(result.requestedClaims[0].sourceUrls, [exact])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('claim verification does not guess between ambiguous one-character redirect matches', async () => {
  const prefix = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'
  const supplied = `${prefix}${'a'.repeat(40)}X`
  await assert.rejects(
    runNativeClaimVerification({ resolveApiKey: async () => 'test-key' }, [{
      claim: 'An ambiguous source supports this.',
      sourceUrls: [supplied],
    }], [
      { uri: `${prefix}${'a'.repeat(40)}Y` },
      { uri: `${prefix}${'a'.repeat(40)}Z` },
    ], undefined, 'gemini-test'),
    (error) => error?.code === 'INVALID_ARGS' && /unknown URL/.test(error.message),
  )
})

test('claim verification keeps whitelisted URL Context sources when metadata is omitted', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'V1 UNREACHABLE: URL Context returned no source metadata.' }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const sourceUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/known-token='
    const result = await runNativeClaimVerification({
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, [{ claim: 'The report states 42.', sourceUrls: [sourceUrl] }], [
      { uri: sourceUrl, title: 'Grounded report' },
    ], undefined, 'gemini-test')
    assert.equal(result.text, 'V1 UNREACHABLE: URL Context returned no source metadata.')
    assert.equal(result.verifications[0].status, 'UNREACHABLE')
    assert.deepEqual(result.sources, [{
      uri: sourceUrl,
      title: 'Supplied verification source 1',
      kind: 'url_context',
    }])
    assert.deepEqual(result.supports, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('claim verification rejects a source-only response without per-claim statuses', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'model' }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const sourceUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/known-token-with-enough-length-1234567890'
    await assert.rejects(
      runNativeClaimVerification({
        baseURL: 'http://127.0.0.1:8080',
        models: ['gemini-test'],
        resolveApiKey: async () => 'test-key',
      }, [{ claim: 'The report states 42.', sourceUrls: [sourceUrl] }], [
        { uri: sourceUrl, title: 'Grounded report' },
      ], undefined, 'gemini-test'),
      (error) => Number(error?.status) === 502 && /no explicit per-claim status/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('claim verification preserves more than twelve claims, batches them, and merges structured outcomes', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    const prompt = body.contents[0].parts[0].text
    const ids = [...prompt.matchAll(/^(V\d+)\. Claim:/gm)].map((match) => match[1])
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: ids.map((id) => `${id} VERIFIED: supported`).join('\n') }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const prefix = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'
  const claims = Array.from({ length: 13 }, (_value, index) => ({
    claim: `Claim ${index + 1}`,
    sourceUrls: [`${prefix}${String(index).repeat(40)}`],
  }))
  try {
    const result = await runNativeClaimVerification({
      baseURL: 'http://127.0.0.1:8080',
      models: ['gemini-test'],
      resolveApiKey: async () => 'test-key',
    }, claims, claims.map((item) => ({ uri: item.sourceUrls[0] })), undefined, 'gemini-test')
    assert.equal(bodies.length, 4)
    assert.deepEqual(bodies.map((body) => (body.contents[0].parts[0].text.match(/^V\d+\. Claim:/gm) ?? []).length), [4, 4, 4, 1])
    assert.equal(result.verifications.length, 13)
    assert.ok(result.verifications.every((item) => item.status === 'VERIFIED'))
    assert.equal(result.sources.length, 13)
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

test('compacts a completed long research response before exposing it to dsh', async () => {
  const packet = [
    'Claim verification evidence packet',
    '',
    'Sources (citation whitelist; copy URLs exactly):',
    '[S1] https://official.example/report — Official report [url_context]',
    '',
    'Verification outcomes:',
    '[V1] PARTIAL: Only the date is supported.',
    '  Sources: S1',
  ].join('\n')
  const longDraft = `# Research report\n\n${'material claim '.repeat(200)}`
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '查最新情况，写一篇研究性文章' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'write-report', name: 'write', arguments: JSON.stringify({ file_path: 'outputs/report.md', content: longDraft }) }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'write-report', content: [{ type: 'text', text: 'Wrote outputs/report.md.' }], isError: false }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'verify-1', name: 'gemini_verify_claims', arguments: '{"claims":[]}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'verify-1', content: [{ type: 'text', text: packet }], isError: false }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'todo-1', name: 'todo_write', arguments: '{"todos":[{"content":"deliver","status":"completed"}]}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'todo-1', content: [{ type: 'text', text: 'Updated todo list: 0 pending, 0 in progress, 1 completed.' }], isError: false }] },
  ]
  const raw = `已完成。\n\n\`outputs/report.docx\`\n\n# 正文\n\n${'正文'.repeat(2_000)}\n\n# 事实核查表\n\n<execute_bash>旧任务计划</execute_bash>`
  const event = { choices: [{ delta: { content: raw }, finish_reason: 'stop' }] }
  const { chunks } = await collectMockedStream(streamResponse([`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`]), {
    model: 'gemini-test',
    messages,
    tools: [
      { name: 'gemini_verify_claims', description: 'verify', parameters: { type: 'object' } },
      { name: 'write', description: 'write', parameters: { type: 'object' } },
      { name: 'todo_write', description: 'update structured task list', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } } } },
    ],
  })
  validateStrictStream(chunks)
  const text = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text').block.text
  assert.match(text, /独立事实核查表尚未成功写入文件/)
  assert.match(text, /outputs\/report\.docx/)
  assert.doesNotMatch(text, /execute_bash|# 正文/)
  assert.ok(text.length < 1_000)
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

test('repairs incomplete list items and double-escaped JSON through the streaming adapter', async () => {
  const escaped = '[\\n  {\\"name\\": \\"alpha\\"}\\n]'
  const event = {
    choices: [{
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_todo',
            function: {
              name: 'todo_write',
              arguments: JSON.stringify({
                todos: [
                  { content: 'Inspect logs', status: 'completed' },
                  { status: 'pending' },
                ],
              }),
            },
          },
          {
            index: 1,
            id: 'call_write',
            function: {
              name: 'write',
              arguments: JSON.stringify({ file_path: 'report.json', content: escaped }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  }
  const { chunks } = await collectMockedStream(streamResponse([`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`]), {
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect and save results' }] }],
    tools: [
      {
        name: 'todo_write',
        parameters: {
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
        },
      },
      {
        name: 'write',
        parameters: {
          type: 'object',
          required: ['file_path', 'content'],
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        },
      },
    ],
  })

  validateStrictStream(chunks)
  const calls = chunks
    .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    .map((chunk) => chunk.block)
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    todos: [{ content: 'Inspect logs', status: 'completed' }],
  })
  assert.deepEqual(JSON.parse(calls[1].arguments), {
    file_path: 'report.json',
    content: '[\n  {"name": "alpha"}\n]',
  })
})

test('classifies textual Gemini quota exhaustion as a rate limit', async () => {
  const response = streamResponse([
    `data: ${JSON.stringify({ error: { code: 'RESOURCE_EXHAUSTED', message: '当前账号配额用完' } })}\n\n`,
  ])
  await assert.rejects(
    () => collectMockedStream(response, {
      model: 'gemini-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
    }),
    (error) => error?.code === 'RATE_LIMIT' && /配额用完/.test(error.message),
  )
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

test('applies the external web fallback guard through the streaming adapter', async () => {
  const event = {
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: 'shell_1',
      function: { name: 'pwsh', arguments: JSON.stringify({ command: 'python -c "import urllib.request; print(urllib.request.urlopen(\'https://example.com\').read())"' }) },
    }] }, finish_reason: 'tool_calls' }],
  }
  const { chunks } = await collectMockedStream(streamResponse([`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`]), {
    model: 'gemini-test',
    messages: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '核实最近消息' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'search_1', name: 'gemini_web_search', arguments: '{"query":"latest"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'search_1', content: [{ type: 'text', text: 'HTTP 429 rate limit' }], isError: true }] },
    ],
    tools: [
      { name: 'gemini_web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } },
    ],
  })

  validateStrictStream(chunks)
  const call = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
  assert.equal(call.name, 'pwsh')
  const args = JSON.parse(call.arguments)
  assert.match(args.command, /External web fallback through PowerShell is disabled/)
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
