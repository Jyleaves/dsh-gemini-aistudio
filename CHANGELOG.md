# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.10] - 2026-08-27

### Added

- Add `gemini_verify_claims`, a second-pass evidence tool that reopens only exact
  URLs returned by prior Gemini-grounded searches and reports unsupported,
  partial, conflicting, or unreachable claims before delivery.

### Changed

- Stop replaying prior private reasoning text into later Gemini requests while
  retaining visible live reasoning and native function-call thought signatures,
  preventing quadratic context growth and old planning text resurfacing.
- Render compact, stable source and claim identifiers instead of repeating the
  provider's full synthesis, reducing long research-turn context growth.
- Compact completed long-form research responses to truthful artifact paths and
  structured verification counts instead of repeating the full report and
  fact-check table in chat.
- Require a fresh successful claim-verification pass after every newer grounded
  lookup before research write or edit tools become available.
- Verify long research deliverables against a complete material-claim inventory
  instead of a small representative sample. Claim verification now accepts up
  to 48 atomic claims and processes them in small sequential URL Context
  batches; fact-check tables must map every submitted claim to an exact source
  URL and verification status.
- Require a post-draft verification pass after a long research document is
  written or edited, and require a separate Markdown fact-check artifact before
  the research goal can be completed.
- Keep verification gates active when dsh injects runtime snapshots, system
  reminders, or expanded skills as user-role messages.
- Allow native Google Search calls up to four minutes and multi-batch claim
  verification up to fifteen minutes.

### Fixed

- Block PowerShell, Python, curl, and similar external-web fallbacks after a
  Gemini native search failure while preserving local commands and localhost
  requests. The blocked tool is removed after the first attempt so a model
  cannot silently replace grounded Google Search with an unrelated search
  engine or unverified shell scraping.
- Remove edit-only `objective` and `max_goal_rounds` fields from `update_goal`
  completion and blocking calls.
- Preserve parent JSON Schema constraints while normalizing `anyOf` and `oneOf`
  variants.
- Share newly grounded sources directly across live search and verification
  tool calls, avoiding stale dsh message snapshots that rejected valid URLs.
- Preserve already-whitelisted URL Context inputs when AI Studio returns
  verification text without repeating source metadata; ordinary web search
  remains strict and still rejects ungrounded prose.
- Aggregate grounded sources across the full turn and prevent research file
  writes from introducing citation URLs that were neither returned by Gemini
  grounding nor supplied by the user.
- Reject source-only or placeholder URL Context responses that omit explicit
  per-claim verification statuses, accept provider statuses in concise or
  Markdown multi-line layouts, repair only uniquely identifiable one- or
  two-character streaming corruption in Google grounding redirect URLs, and
  downgrade misleading verified labels when a written citation is outside the
  grounded source whitelist.
- Reconcile translated fact-check rows with structured verification outcomes
  by matching the row ordinal (`1`, `2`, ...) to `V1`, `V2`, ... together with
  the same exact verified URL, avoiding contradictory UNVERIFIED labels when
  the prose language differs from the provider's verification sentence.
- Preserve the latest structured claim-verification statuses in fact-check
  files, downgrade claims that were not fully verified, and append omitted
  canonical outcomes.
- Strip streamed JSON suffixes only after a complete Google grounding redirect
  token and still require an exact source-whitelist match.

### Tests

- Add regressions for strict verification schemas, live-agent source sharing,
  multi-search source aggregation, citation whitelisting, compact evidence
  rendering, URL Context-only verification, typo repair, false-verification
  rejection, safe verification batching, and fresh-verification gating.
- Add regressions for injected runtime/skill messages and for fact-check rows
  that combine `VERIFIED / 已核`, claim exact support without an exact verified
  URL, or retain affirmative prose after being downgraded.
- Add regressions for reasoning-history compaction, research artifact gates,
  final-response compaction, `update_goal` repair, and blocked external-web
  shell fallback. The complete automated suite passes 103 tests.
- Verify that dsh restarts from the source Junction and serves the Web UI on
  `127.0.0.1:3080`; live grounded-article completion remains dependent on
  available upstream AI Studio quota.

## [0.1.9] - 2026-08-26

### Changed

- Resolve Chinese relative-time phrases with written numerals, preserve the
  actual human request when dsh injects runtime context as user-role messages,
  and reject search evidence outside an explicitly requested rolling window.
- Reuse a uniquely identified URL from the prior grounded result when the user
  asks to inspect that source, without hard-coding sites, owners, or projects.

### Fixed

- Drop incomplete objects from schema-defined tool arrays, preventing malformed
  task-list entries such as status-only items from reaching dsh tools.
- Decode an accidentally double-escaped `.json` document only when the decoded
  content passes strict JSON parsing; valid JSON and non-JSON files are left
  unchanged.
- Treat textual `RESOURCE_EXHAUSTED`, quota, and rate-limit stream errors as
  `RATE_LIMIT` even when the provider does not return a numeric HTTP status.
- Prevent settled subagent identifiers from being reused as background-job IDs.

### Tests

- Add unit and streaming regressions for incomplete required array items,
  double-escaped JSON writes, textual quota errors, relative-time handling, and
  prior-source URL Context. The complete automated suite passes 76 tests.
- Verify a fresh dsh Web conversation using Gemini Flash Lite Latest: task-list
  creation, JSON write, read-back, strict external parsing, and final task
  completion all succeeded without tool-call errors. Asteria recovered two
  upstream 429 responses by rotating accounts and replaying the same request.

## [0.1.8] - 2026-08-26

### Added

- Add runtime date and time-zone anchoring for time-sensitive web research,
  including computed rolling windows for explicit relative durations such as
  the past N hours, days, weeks, months, or years.
- Return Gemini grounding source URLs and claim-to-source mappings from native
  web lookup results so the agent can trace material claims to provider
  evidence.

### Changed

- Inherit the current dsh conversation's selected Gemini model for native web
  lookup. Keep `searchModel` and `searchFallbackModel` as explicit operator
  overrides instead of silently forcing 3.5 or 3.7 across all conversations.
- Enable native Google Search for ordinary research and add URL Context only
  when the query contains an explicit public URL.
- Raise the per-turn native search budget from four to six while retaining
  duplicate-query convergence and per-tool failure suppression.
- Preserve evidence status across official statements, attributed analysis,
  channel checks, rumors, and model inference; do not synthesize unsupported
  causal relationships or company actions from separate reports.

### Fixed

- Reject search-like model prose that has no provider grounding URL instead of
  presenting it as verified web evidence.
- Preserve user relative-time constraints in the actual search-tool arguments
  even when Gemini initially emits only a broad month or year.
- Repair streamed JSON leakage after an unambiguous enum value without fuzzy
  coercion of genuinely invalid enum strings.
- Recover safely from stale agent job identifiers and transient native-search
  provider failures without infinite retries or treating errors as evidence.

### Tests

- Add regression coverage for dynamic time windows, grounded-source extraction,
  claim mapping, conditional URL Context, source-less response rejection,
  per-conversation model inheritance, explicit model fallback, enum leakage,
  and stale-job recovery.
- Verify against Asteria's raw AI Studio exchange that `gemini-3.5-flash`
  executes Google Search and returns grounding chunks/supports; the missing
  sources were caused by proxy response-field loss, not the selected model.

## [0.1.7] - 2026-08-25

### Changed

- Add schema- and runtime-driven recovery guidance for missing required tool
  fields, stale edit anchors, invalid single-glob filters, over-broad searches,
  non-widening sandbox requests, and empty native web-search queries.
- Keep each provider tool call as an independent JSON object and explicitly
  forbid leaking provider control markers into another tool's arguments.

### Fixed

- Remove `sandbox_permissions` and `justification` when Gemini requests the
  current or a narrower sandbox mode, while preserving genuinely wider
  escalation requests.
- Convert comma-separated `grep.include` values to one brace-alternation glob
  when the active dsh tool Schema declares a single glob.
- Reject blank `gemini_web_search` input before network access so its output can
  never contain a non-lossless `undefined` query value.
- Reclassify echoed internal tool-completion notifications as reasoning instead
  of exposing them as normal assistant answer text.
- Stop repeated equivalent operational failures for only the affected tool,
  leaving unrelated tools available so the agent can recover safely.

### Tests

- Add streaming-adapter regression coverage for runtime sandbox repair,
  single-glob normalization, fragmented internal-notification filtering, and
  ordinary text preservation; the complete suite now passes 63 tests.
- Verify a fresh dsh Web session with Gemini Flash Lite Latest at High reasoning
  across `todo_write`, `write`, `grep`, and `read`: all three tasks completed in
  seven model steps with no tool error and reasoning remained in the Think UI.

## [0.1.6] - 2026-08-25

### Fixed

- Normalize malformed Gemini arguments recursively for every dsh tool: omit
  optional non-nullable `null` values, preserve schema-approved nulls, coerce
  unambiguous boolean/number/integer/string values, canonicalize enum casing,
  and apply only deterministic schema defaults.
- Preserve invalid required values when no safe schema fallback exists instead
  of inventing user intent, while stopping repeated argument-validation loops
  after two equivalent failures and keeping unrelated tools available.
- Count only successful tool results as task-list progress, so failed task
  writes do not become canonical and failed work cannot advance todo status.
- Keep local tools available after Gemini native search reaches its per-turn
  budget or converges on near-equivalent results; only the search tool is
  removed.

### Tests

- Add regression coverage for nullable and non-nullable scalars, nested arrays,
  enum/default repair, repeated validation failures, failed todo transitions,
  and search-budget isolation.
- Verify a real dsh web session with two parallel subagents plus `todo_write`,
  `read`, `glob`, `pwsh`, and `list_agents`; all four tasks completed without an
  `INVALID_ARGS` event.

## [0.1.5] - 2026-08-25

### Changed

- Preserve assistant reasoning as Gemini thought history or OpenAI-compatible
  `reasoning_content` instead of replaying private analysis as normal answer
  text.
- Add general execution guidance that keeps tool-capable Gemini turns working
  until completion or a genuine user-input blocker.
- Converge near-equivalent successful Gemini native searches and force the
  following model step to answer from existing evidence, preventing fallback
  through legacy search, skills, or shell-based network access.

### Fixed

- Sanitize every third-party tool JSON Schema before both Gemini native and
  OpenAI-compatible requests. Missing, nullable, union-style, and nested types
  are converted to provider-valid declarations without task-specific patches.
- Keep task-list wording and status monotonic across multi-step work, suppress
  repeated task-list rewrites until a non-task tool result makes progress, and
  require a final completed list before the answer.
- Prevent Gemini from ending a tool-capable turn with planning text while
  useful work remains.

### Tests

- Add regression coverage for untyped third-party schemas, reasoning-history
  separation, task-list lifecycle enforcement, and near-equivalent search
  convergence while preserving distinct research queries.
- Verify real dsh sessions using `write`, `edit`, `glob`, `grep`, `read`,
  `read_image`, `pwsh`, `todo_write`, and Gemini native web search.

## [0.1.4] - 2026-08-25

### Changed

- Emit explicit block start and end events for text, reasoning, and tool calls
  on both native Gemini and OpenAI-compatible streaming routes.
- Reserve independent stream indexes for text, reasoning, and tool-call blocks
  so dsh can assemble mixed responses deterministically.
- Replace dsh's DeepSeek-backed `web_search` and `web_fetch` for Gemini sessions
  with `gemini_web_search`, backed exclusively by Gemini native Google Search
  and URL Context through Asteria.
- Cap Gemini native web lookup calls at four per user turn by default and guide
  exact URLs, repositories, package coordinates, DOI/CVE identifiers, and
  quoted errors into one precise lookup.
- Forbid substituting similarly named projects for an unverified exact target;
  ask for a unique owner, identifier, or URL instead of guessing.
- Guide exact lookup through a domain-independent identity-resolution chain:
  quoted-name discovery, canonical identifier or URL, then primary-page
  verification.

### Fixed

- Prevent strict dsh stream consumers from ending a Gemini turn immediately
  when the provider returned a valid response.
- Preserve fragmented tool arguments, native thought signatures, and the final
  SSE event when a provider closes the stream without a trailing newline.
- Surface completed-but-empty provider responses as an explicit error instead
  of silently ending the conversation.
- Normalize Gemini and OpenAI finish reasons after all open blocks have closed.
- Register the native web-search tool with a provider-valid object JSON Schema,
  preventing every Gemini request from failing before the tool is called.
- Keep consecutive Gemini tool calls separate when an older Asteria stream
  omits OpenAI tool-call indexes, instead of concatenating their JSON inputs.
- Repair malformed arguments for arbitrary dsh tools from their declared JSON
  Schema, including invalid object-array entries and undeclared fields.
- Preserve extension fields for open JSON Schemas; remove unknown properties
  only when the tool explicitly declares `additionalProperties: false`.
- Fill omitted required string `description` fields at any declared object
  level, covering `pwsh`, `run_code`, and workflow metadata without task-
  specific argument patches.
- Remove orphaned escalation `justification` fields for every tool when no
  `sandbox_permissions` request accompanies them, while preserving valid
  approval requests unchanged.
- Limit native web lookup to one call per model response so parallel near-
  duplicate searches cannot bypass the per-turn budget.
- Clarify that a no-browsing request disables only native web lookup while
  retaining non-network local tools for computation, runtime state, workspace
  inspection, transformations, and verification within the user's scope.
- Prevent shell, package-manager, script, or local-browser network requests
  from bypassing Gemini native web lookup. Treat successful local-tool output
  as reusable evidence and stop semantically equivalent confirmation loops.
- Temporarily suppress an exactly repeated consecutive local-tool operation
  until another tool makes progress, without blocking legitimate later reuse.
- Stop local discovery after two independent empty results and request the
  missing workspace, path, or identifier instead of cycling through tools.

### Tests

- Add strict stream-invariant coverage for native text/reasoning, OpenAI text,
  reasoning and fragmented tool calls, thought signatures, and empty responses.
- Add a regression assertion for the exact native-search input schema exposed
  to dsh and Asteria.
- Cover index-less consecutive tool calls from older proxy releases.
- Cover parallel native-search suppression in a single model response.
- Cover generic recursive `description` repair, invalid object-array cleanup,
  open-schema extension preservation, and orphaned escalation fields.
- Cover deterministic clarification after distinct empty local discoveries,
  while preserving tool access after one empty or any substantive result.

## [0.1.3] - 2026-08-25

### Added

- Add `添加图片` and `添加 PDF` entries to dsh's existing composer plus menu.
- Declare image input and selectable reasoning efforts even when model discovery
  temporarily falls back to the built-in catalog.
- Add an opt-in, version-locked, reversible patch for dsh `0.1.1-rc.2` users
  who need generic-provider discovery to retain image and reasoning metadata.

### Changed

- Let dsh own image paste and upload so images retain the native thumbnail,
  validation, persistence, and message attachment lifecycle.
- Restrict the plugin upload path to PDFs and keep the attachment UI inside the
  existing plus menu instead of rendering a separate composer control.
- Resolve credentials from dsh's credential service, accepting both
  `GEMINI_AISTUDIO_API_KEY` and `AISTUDIO_API_KEY` references.
- Resolve the attachment service at request time and use port `8080` as the
  default local Asteria endpoint.
- Coalesce concurrent model-discovery calls so one model selector refresh sends
  only one request to Asteria.

### Fixed

- Keep image and PDF turns on native Gemini even when dsh exposes custom tools.
- Avoid failing the whole native provider during model discovery when a key has
  not yet been configured.
- Accept both camel-case and snake-case Asteria model metadata.
- Cover complete proxy-catalog metadata import, including snake-case input
  modalities, with a regression test.
- Defensively discard null todo entries returned by older proxy versions while
  preserving the proxy's general tool-argument repair as the primary fix.

## [0.1.2] - 2026-08-24

### Added

- Accept PDF and supported image files from clipboard file items, copied local
  paths, `file://` clipboard URIs, and drag-and-drop in the upload dock.
- Remove abandoned temporary uploads after 24 hours.

### Changed

- Stream browser uploads as raw binary instead of building ArrayBuffer,
  binary-string, Base64, and JSON copies in the browser and server.
- Bypass the in-memory media cache for large encoded entries and account for
  retained Base64 size rather than source-file size.
- Scan PDF page markers directly in the byte buffer and support cancellation
  while reading local media.
- Align the upload endpoint's default size limit with the configured PDF limit.

### Fixed

- Correct stale PDF cache accounting so replacing a file cannot make the cache
  grow indefinitely.
- Avoid reading PDF uploads twice through the generic media path.
- Reject files that change while being read instead of forwarding a mixed or
  truncated attachment.
- Handle Windows Explorer clipboard formats that do not populate
  `clipboardData.files`.

## [0.1.1] - 2026-08-24

### Added

- Advertise `Minimal`, `Low`, `Medium`, and `High` reasoning efforts to dsh,
  with `High` selected by default.
- Add regression coverage for bundle mounting, client discovery, prepared
  calls, reasoning forwarding, tool-call history, original images, and PDFs.

### Changed

- Forward the selected reasoning effort through native Gemini and
  OpenAI-compatible tool-call requests.
- Preserve Gemini thought signatures when replaying dsh function-call history.

### Fixed

- Mount the plugin automatically when its package is included in a dsh profile.
- Implement dsh's prepared-call adapter contract so native requests can start.
- Export package metadata so dsh can discover the browser module.
- Ship the upload control as a dsh browser bundle, restoring original-image and
  PDF uploads in the conversation composer.
- Repair missing PowerShell tool descriptions and remove stray write/edit
  justifications before forwarding tool schemas to Gemini.

[Unreleased]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.0...v0.1.1
