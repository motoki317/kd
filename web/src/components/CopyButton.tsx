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
    <button class="copy-btn" classList={{ copied: copied() }} onClick={copy} title={props.title ?? 'Copy'}>
      {copied() ? (
        <>
          {/* Tiny check glyph + word — confirms the copy without the button changing width
              meaningfully (Copy ≈ Copied in pixel-width once a check icon prefixes the text). */}
          <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
            <path d="M 1.5 5.5 L 4 8 L 8.5 2.5" />
          </svg>
          Copied
        </>
      ) : (
        'Copy'
      )}
    </button>
  )
}
