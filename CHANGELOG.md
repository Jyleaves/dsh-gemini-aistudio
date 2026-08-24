# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Jyleaves/dsh-gemini-aistudio/compare/v0.1.0...v0.1.1
