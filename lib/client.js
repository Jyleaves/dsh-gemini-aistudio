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
  const data = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(data)
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  const response = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, type: file.type, size: file.size, data: btoa(binary) }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.ok) throw new Error(result.error ?? `上传失败（HTTP ${response.status}）`)
  return result.file
}

function isSupported(file) { return file && (file.type.startsWith('image/') || file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) }

function GeminiUploadDock({ input, inputActions }) {
  const [status, setStatus] = useState(null)
  const inputRef = useRef(null)
  const addFile = async (file) => {
    if (!isSupported(file)) return setStatus({ kind: 'error', text: '只支持图片和 PDF' })
    setStatus({ kind: 'busy', text: `正在上传 ${file.name}…` })
    try {
      const uploaded = await upload(file)
      const label = `[Gemini附件：${uploaded.name}，${formatBytes(uploaded.bytes)}]`
      inputActions?.setDraft(input?.draft ? `${input.draft}\n${label}\n${uploaded.marker}` : `${label}\n${uploaded.marker}`)
      setStatus({ kind: 'ok', text: `已上传：${uploaded.name}（原图/PDF，${formatBytes(uploaded.bytes)}）`, marker: uploaded.marker, label })
    } catch (error) { setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) }
  }
  useEffect(() => {
    const onPaste = (event) => {
      const file = [...(event.clipboardData?.files ?? [])].find(isSupported)
      if (!file) return
      event.preventDefault()
      void addFile(file)
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  })
  const clear = () => {
    if (!status?.marker || !inputActions) return
    inputActions.setDraft((input?.draft ?? '').split('\n').filter((line) => line !== status.marker && line !== status.label).join('\n'))
    setStatus(null)
  }
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12, color: status?.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' } },
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
