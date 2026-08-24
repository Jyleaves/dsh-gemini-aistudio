# dsh-gemini-aistudio

Native Gemini provider for DeepSeek Harness. It is isolated under the provider route `aistudio-gemini` and does not replace DeepSeek or the generic `llm-pi-ai` adapter.

Features:

- Uses the proxy's native `/v1beta/models/{model}:streamGenerateContent` endpoint.
- Sends dsh images as native Gemini `inlineData`.
- Adds a dsh upload control for original images and PDFs. These uploads bypass dsh's image normalization and are attached as their original bytes.
- Supports pasting a PDF from the clipboard into the composer; the upload row shows success, failure, and removal.
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

Create a key in the proxy's **API Key 管理** page first, then set it in the environment visible to dsh:

```powershell
$env:AISTUDIO_API_KEY = 'the key copied from the proxy UI'
```

The plugin defaults to `http://127.0.0.1:8090` and enables Google Search. The native provider reads `/v1/models`; it supplies context window, maximum output tokens, input modalities, and the selectable `Minimal`, `Low`, `Medium`, and `High` reasoning efforts automatically. `High` is the default.

If you prefer dsh's generic OpenAI-compatible provider instead of the native plugin route, add one manually:

| Field | Value |
|---|---|
| Provider ID | `gemini-aistudio` |
| Display name | `Google AI Studio` |
| API address | `http://127.0.0.1:8090/v1` |
| API protocol | `openai-completions` |
| API key | Any active local proxy key |

After clicking **Get available models**, select `gemini-3.7-flash` (or another returned Gemini model). Current proxy metadata supplies reasoning efforts and limits, so supported dsh versions should not require those fields to be re-entered by hand.

Use the `上传原图 / PDF` control below the composer, or paste an image/PDF into the composer. After a successful upload, the plugin adds a private marker to the draft and shows `已上传`. The file is sent to Gemini only when the message is submitted. Normal dsh image attachments keep their original dsh behavior; use this control when exact source bytes are required.

When dsh supplies custom tools such as `read`, `edit`, or `bash`, the plugin uses `/v1/chat/completions` for that turn so tool calls and tool results can complete without Gemini's native AI Studio replay permission error. Google Search is kept for plain native Gemini turns; it is not implicitly mixed into custom-tool turns.

PDF paths are still detected in the latest user message for compatibility. The current dsh attachment protocol exposes images only and has no generic Files API for PDFs, so the plugin supplies a local upload endpoint and keeps the file in a private temporary directory until it is sent.

## Limits

The default PDF limit is 20 MiB and 300 pages. The upload control accepts up to 32 MiB, while the Gemini media cache follows the configured `pdf.maxBytes` limit. A PDF is still sent inline to the proxy; it is not uploaded to a persistent Google Files URI. The proxy may spend time rebuilding AI Studio state after an account switch, but this plugin avoids rereading and re-encoding the local file for each retry.

## Update

After this project has an upstream Git remote, update it from the project directory:

```powershell
.\update-dsh-gemini-aistudio.ps1 -CheckOnly
.\update-dsh-gemini-aistudio.ps1
```

The script refuses to update a dirty worktree and uses `git pull --ff-only`. Restart dsh after updating so both the server adapter and browser bundle are reloaded.

## License

MIT. This plugin is independent code and is not an official DeepSeek or Google package.
