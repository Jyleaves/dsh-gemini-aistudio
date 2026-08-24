# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.0...v0.1.1
