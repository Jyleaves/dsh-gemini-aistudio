window.__ModuleLoader__.load({
  id: 'dsh-gemini-aistudio',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useEffect, useRef, useState } = React

const API = '/dsh-gemini-aistudio/api/upload'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function upload(file) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.ok) throw new Error(result.error ?? `上传失败（HTTP ${response.status}）`)
  return result.file
}

function isSupported(file) { return file && /\.(?:pdf|png|jpe?g|webp|gif|avif)$/i.test(file.name) }

function pastedFile(data) {
  const files = [...(data?.files ?? [])]
  for (const item of data?.items ?? []) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  return files.find(isSupported)
}

function pastedLocalPath(data) {
  const raw = data?.getData('text/uri-list') || data?.getData('text/plain') || ''
  const first = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'))
  if (!first) return null
  let value = first.replace(/^["']|["']$/g, '')
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
    } catch { return null }
  }
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/).+\.(?:pdf|png|jpe?g|webp|gif|avif)$/i.test(value)) return null
  return /^[A-Za-z]:\//.test(value) ? value.replace(/\//g, '\\') : value
}

function GeminiUploadDock({ input, inputActions }) {
  const [status, setStatus] = useState(null)
  const inputRef = useRef(null)
  const addMarker = (marker, label, text) => {
    inputActions?.setDraft(input?.draft ? `${input.draft}\n${label}\n${marker}` : `${label}\n${marker}`)
    setStatus({ kind: 'ok', text, marker, label })
  }
  const addFile = async (file) => {
    if (!isSupported(file)) return setStatus({ kind: 'error', text: '只支持图片和 PDF' })
    setStatus({ kind: 'busy', text: `正在上传 ${file.name}…` })
    try {
      const uploaded = await upload(file)
      const label = `[Gemini附件：${uploaded.name}，${formatBytes(uploaded.bytes)}]`
      addMarker(uploaded.marker, label, `已上传：${uploaded.name}（原图/PDF，${formatBytes(uploaded.bytes)}）`)
    } catch (error) { setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) }
  }
  useEffect(() => {
    const onPaste = (event) => {
      const file = pastedFile(event.clipboardData)
      if (file) {
        event.preventDefault()
        event.stopPropagation()
        void addFile(file)
        return
      }
      const localPath = pastedLocalPath(event.clipboardData)
      if (!localPath) return
      event.preventDefault()
      event.stopPropagation()
      const name = localPath.split(/[\\/]/).pop() || '附件'
      const marker = `[[dsh-gemini-file:${localPath}]]`
      addMarker(marker, `[Gemini附件：${name}]`, `已粘贴本地文件：${name}`)
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [input?.draft, inputActions])
  const clear = () => {
    if (!status?.marker || !inputActions) return
    inputActions.setDraft((input?.draft ?? '').split('\n').filter((line) => line !== status.marker && line !== status.label).join('\n'))
    setStatus(null)
  }
  return React.createElement('div', {
    onDragOver: (event) => { if (pastedFile(event.dataTransfer)) event.preventDefault() },
    onDrop: (event) => { const file = pastedFile(event.dataTransfer); if (file) { event.preventDefault(); void addFile(file) } },
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12, color: status?.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' },
  },
    React.createElement('input', { ref: inputRef, type: 'file', accept: 'image/*,.pdf,application/pdf', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; if (file) void addFile(file); event.target.value = '' } }),
    React.createElement('button', { type: 'button', onClick: () => inputRef.current?.click(), disabled: status?.kind === 'busy' }, '上传原图 / PDF'),
    status && React.createElement('span', { title: status.text, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, status.kind === 'busy' ? '⏳ ' : status.kind === 'ok' ? '✓ ' : '⚠ ', status.text),
    status?.kind === 'ok' && React.createElement('button', { type: 'button', onClick: clear }, '移除')
  )
}

const name = 'dsh-gemini-aistudio/client'
const inject = ['slots']

function apply(ctx) {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'gemini-aistudio-upload', order: 15,
  }, GeminiUploadDock))
}

exports.name = name
exports.inject = inject
exports.apply = apply
return module.exports
  },
})
