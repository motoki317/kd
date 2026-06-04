import { createSignal } from 'solid-js'

// CopyButton copies the text returned by props.text() to the clipboard and briefly confirms.
// Silently no-ops when the Clipboard API is unavailable (e.g. a non-secure context).
//
// Optional altText/altTitle (cycle 287): when present, Shift+click copies altText instead. Used by
// the drawer's name button so plain click copies just the name (the common case — pasting into
// chat) while Shift+click copies "Kind/name" for kubectl pipelines. The title gets a "· ⇧ for
// <altTitle>" suffix so the modifier is discoverable.
export default function CopyButton(props: {
  text: () => string
  title?: string
  altText?: () => string
  altTitle?: string
}) {
  const [copied, setCopied] = createSignal(false)
  const copy = async (e: MouseEvent) => {
    // Capture the value choice synchronously so the post-await flash matches what was copied.
    const useAlt = e.shiftKey && !!props.altText
    const text = useAlt ? props.altText!() : props.text()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }
  const title = () => {
    const base = props.title ?? 'Copy'
    return props.altText ? `${base} · Shift+click ${props.altTitle ?? 'for alt'}` : base
  }
  return (
    <>
      {/* Stable aria-label (not the toggling "Copy"/"Copied" text) so the button reads consistently;
          success is announced via the polite live region below — the reliable way to confirm to a
          screen reader, since a focused button's own label change isn't auto-announced. */}
      <button class="copy-btn" classList={{ copied: copied() }} onClick={copy} aria-label={title()} title={title()}>
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
      <span class="sr-only" role="status">{copied() ? 'Copied to clipboard' : ''}</span>
    </>
  )
}
