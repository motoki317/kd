import { createSignal } from 'solid-js'

// CopyButton copies the text returned by props.text() to the clipboard and briefly confirms.
// Silently no-ops when the Clipboard API is unavailable (e.g. a non-secure context).
export default function CopyButton(props: { text: () => string; title?: string }) {
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text())
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button class="copy-btn" onClick={copy} title={props.title ?? 'Copy'}>
      {copied() ? 'Copied' : 'Copy'}
    </button>
  )
}
