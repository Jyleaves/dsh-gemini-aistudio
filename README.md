# dsh-gemini-aistudio

Native Gemini provider for DeepSeek Harness. It is isolated under the provider route `aistudio-gemini` and does not replace DeepSeek or the generic `llm-pi-ai` adapter.

Features:

- Uses the proxy's native `/v1beta/models/{model}:streamGenerateContent` endpoint.
- Sends dsh's native image attachments as Gemini `inlineData`, preserving dsh's
  thumbnail and attachment lifecycle.
- Adds `添加图片` and `添加 PDF` to the composer's existing plus menu. Images use
  dsh's native attachment path; PDFs are streamed through the plugin endpoint.
- Supports pasting PDFs into the composer, including Windows Explorer clipboard
  paths.
- Detects a PDF path in the latest user message and sends it as native `application/pdf` inline data.
- Caches PDF bytes by path, size, and modification time, so account rotation does not reread the local file.
- Rejects oversized or excessively long PDFs before network upload.
- Sends Gemini's native `googleSearch` tool when enabled.
- Routes dsh custom function-tool turns through the proxy's OpenAI-compatible endpoint, because AI Studio's native function-result replay is unstable for this account bridge. Plain Gemini turns keep the native endpoint.

## Install

From the dsh profile directory, install directly from GitHub:

```powershell
dsh plugin --profile web add https://github.com/Jyleaves/dsh-gemini-aistudio.git
```

For local development, replace the GitHub URL with the local project directory.

Restart dsh after installation. The bundle automatically mounts the native provider route `aistudio-gemini`, loads its browser upload control, and discovers models from the proxy. It does not replace DeepSeek or create a duplicate generic provider entry.

Create a key in Asteria's **API Key 管理** page first. The plugin resolves the
credential reference stored by dsh and accepts either `GEMINI_AISTUDIO_API_KEY`
or `AISTUDIO_API_KEY`. An environment variable is still supported when desired:

```powershell
$env:AISTUDIO_API_KEY = 'the key copied from the proxy UI'
```

The plugin defaults to `http://127.0.0.1:8080` and enables Google Search. The native provider reads `/v1/models`; it supplies context window, maximum output tokens, input modalities, and the selectable `Minimal`, `Low`, `Medium`, and `High` reasoning efforts automatically. `High` is the default.

If you prefer dsh's generic OpenAI-compatible provider instead of the native plugin route, add one manually:

| Field | Value |
|---|---|
| Provider ID | `gemini-aistudio` |
| Display name | `Google AI Studio` |
| API address | `http://127.0.0.1:8080/v1` |
| API protocol | `openai-completions` |
| API key | Any active local proxy key |

The native `Google AI Studio (native)` route is recommended. Current dsh generic
OpenAI discovery imports only model IDs, names, context windows, and output
limits; its discovery contract does not carry provider-specific image or
reasoning metadata. The native route bypasses that restricted contract and
declares both capabilities explicitly.

Users who deliberately need the generic provider can opt into the versioned
dsh `0.1.1-rc.2` discovery patch. It backs up every touched host file, refuses
unknown builds, and can be restored:

```powershell
.\patch-dsh-model-discovery.ps1 -CheckOnly
.\patch-dsh-model-discovery.ps1
# Restore the original dsh files when needed:
.\patch-dsh-model-discovery.ps1 -Restore
```

Restart `dsh web`, fetch the model list again, and save it. The imported model
rows will then retain image input and per-model reasoning efforts in addition
to their names and capacities. A dsh upgrade replaces host package files, so
rerun `-CheckOnly`; never force this patch onto an unsupported version.

Open the composer's plus menu and choose `添加图片` or `添加 PDF`. Pasted images
also use dsh's native thumbnail attachment. A PDF is sent to Gemini only when
the message is submitted; a copied local PDF path remains supported for Windows
Explorer compatibility.

When dsh supplies custom tools such as `read`, `edit`, or `bash`, the plugin uses `/v1/chat/completions` for that turn so tool calls and tool results can complete without Gemini's native AI Studio replay permission error. Google Search is kept for plain native Gemini turns; it is not implicitly mixed into custom-tool turns.

PDF paths are still detected in the latest user message for compatibility. The current dsh attachment protocol exposes images only and has no generic Files API for PDFs, so the plugin supplies a local upload endpoint and keeps the file in a private temporary directory until it is sent.

## Limits

The default PDF and upload limit is 20 MiB and 300 pages. A PDF is still sent inline to the proxy; it is not uploaded to a persistent Google Files URI. Large encoded files bypass the long-lived in-memory cache, uploads are streamed to disk, and stale temporary uploads are removed after 24 hours. The proxy may spend time rebuilding AI Studio state after an account switch, but a request body is reused across the proxy's account retries.

Gemini thinking and visible text share the request's maximum output-token budget. Keep the plugin's normal model limit when using `High`; manually reducing it to tens or hundreds of tokens can leave room for only a very short visible answer after reasoning.

The adapter forwards dsh function tools, but autonomous visual QA still depends on the tools installed in the active dsh profile. For a presentation workflow, expose a renderer plus an image-inspection tool and explicitly require the agent to render and inspect the result before completion; the provider cannot invent a screenshot or PDF-reading tool that dsh did not supply.

## Update

After this project has an upstream Git remote, update it from the project directory:

```powershell
.\update-dsh-gemini-aistudio.ps1 -CheckOnly
.\update-dsh-gemini-aistudio.ps1
```

The script refuses to update a dirty worktree and uses `git pull --ff-only`. Restart dsh after updating so both the server adapter and browser bundle are reloaded.

## License

MIT. This plugin is independent code and is not an official DeepSeek or Google package.
