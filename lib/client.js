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

function isPdf(file) { return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) }

function pastedPdf(data) {
  const files = [...(data?.files ?? [])]
  for (const item of data?.items ?? []) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  return files.find(isPdf)
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
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/).+\.pdf$/i.test(value)) return null
  return /^[A-Za-z]:\//.test(value) ? value.replace(/\//g, '\\') : value
}

function closeCommandMenu() {
  const button = document.querySelector('button[aria-label="命令"][aria-expanded="true"]')
  if (button instanceof HTMLElement) button.click()
}

function dispatchNativeImages(files) {
  const textarea = document.querySelector('textarea[aria-label="给智能体发消息"]')
  if (!(textarea instanceof HTMLElement) || !files.length) return false
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  textarea.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  }))
  textarea.focus()
  return true
}

function menuItem(label, icon, onPick) {
  const row = document.createElement('div')
  row.setAttribute('role', 'option')
  row.setAttribute('aria-label', label)
  row.tabIndex = 0
  row.dataset.geminiAttachmentItem = label
  row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;min-height:36px'
  row.innerHTML = `<span aria-hidden="true" style="display:grid;place-items:center;width:20px;height:20px">${icon}</span><span>${label}</span>`
  const pick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    closeCommandMenu()
    onPick()
  }
  row.addEventListener('click', pick)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') pick(event)
  })
  row.addEventListener('mouseenter', () => { row.style.background = 'var(--dsw-specific-selector)' })
  row.addEventListener('mouseleave', () => { row.style.background = '' })
  return row
}

function AttachmentMenu({ input, inputActions }) {
  const [status, setStatus] = useState(null)
  const imageInputRef = useRef(null)
  const pdfInputRef = useRef(null)
  const addMarker = (marker, label, text) => {
    inputActions?.setDraft(input?.draft ? `${input.draft}\n${label}\n${marker}` : `${label}\n${marker}`)
    setStatus({ kind: 'ok', text, marker, label })
  }
  const addFile = async (file) => {
    if (!isPdf(file)) return setStatus({ kind: 'error', text: '请选择 PDF 文件' })
    setStatus({ kind: 'busy', text: `正在上传 ${file.name}…` })
    try {
      const uploaded = await upload(file)
      const label = `[Gemini PDF：${uploaded.name}，${formatBytes(uploaded.bytes)}]`
      addMarker(uploaded.marker, label, `已添加 PDF：${uploaded.name}（${formatBytes(uploaded.bytes)}）；点击按钮可移除`)
    } catch (error) { setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) }
  }
  useEffect(() => {
    const onPaste = (event) => {
      const file = pastedPdf(event.clipboardData)
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
      const name = localPath.split(/[\\/]/).pop() || 'document.pdf'
      const marker = `[[dsh-gemini-file:${localPath}]]`
      addMarker(marker, `[Gemini PDF：${name}]`, `已添加本地 PDF：${name}；点击按钮可移除`)
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [input?.draft, inputActions])
  useEffect(() => {
    const enhance = () => {
      for (const listbox of document.querySelectorAll('[role="listbox"]')) {
        if (!listbox.textContent?.includes('命令') || listbox.querySelector('[data-gemini-attachment-menu]')) continue
        const group = document.createElement('div')
        group.dataset.geminiAttachmentMenu = 'true'
        group.style.cssText = 'display:flex;flex-direction:column;padding:4px'
        group.append(
          menuItem('添加图片', '<svg viewBox="0 0 24 24" width="17" height="17" fill="none"><path d="M4 5.5h16v13H4zM7 15l3-3 2.5 2.5 1.5-1.5 3 3M15.5 9h.01" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>', () => imageInputRef.current?.click()),
          menuItem('添加 PDF', '<svg viewBox="0 0 24 24" width="17" height="17" fill="none"><path d="M7 3.75h7l3 3V20.25H7zM14 3.75v3h3M9.5 12h5M9.5 15h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>', () => pdfInputRef.current?.click()),
        )
        const firstOption = listbox.querySelector('[role="option"]')
        if (firstOption instanceof HTMLElement) {
          const nativeLabel = [...firstOption.querySelectorAll('*')]
            .find((node) => node instanceof HTMLElement && node.children.length === 0 && node.textContent?.trim())
          const nativeStyle = getComputedStyle(nativeLabel instanceof HTMLElement ? nativeLabel : firstOption)
          for (const row of group.children) {
            if (!(row instanceof HTMLElement)) continue
            row.style.fontFamily = nativeStyle.fontFamily
            row.style.fontSize = nativeStyle.fontSize
            row.style.fontWeight = nativeStyle.fontWeight
            row.style.lineHeight = nativeStyle.lineHeight
            row.style.color = nativeStyle.color
          }
        }
        listbox.insertBefore(group, firstOption ?? null)
      }
    }
    enhance()
    const observer = new MutationObserver(enhance)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return React.createElement('span', { 'data-gemini-attachment-controller': true, hidden: true },
    React.createElement('input', { ref: imageInputRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, onChange: (event) => { dispatchNativeImages([...(event.target.files ?? [])]); event.target.value = '' } }),
    React.createElement('input', { ref: pdfInputRef, type: 'file', accept: '.pdf,application/pdf', onChange: (event) => { const file = event.target.files?.[0]; if (file) void addFile(file); event.target.value = '' } }),
    React.createElement('span', { role: 'status', 'aria-live': 'polite' }, status?.text ?? '')
  )
}

const name = 'dsh-gemini-aistudio/client'
const inject = ['slots']

function apply(ctx) {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'gemini-aistudio-attachments', order: 15,
  }, AttachmentMenu))
}

exports.name = name
exports.inject = inject
exports.apply = apply
return module.exports
  },
})
