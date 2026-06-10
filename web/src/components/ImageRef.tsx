import { createMemo, Show } from 'solid-js'
import CopyButton from './CopyButton'

// isFloatingImageTag returns true when the image reference isn't pinned to an immutable revision:
// no tag at all (implicit :latest), explicit :latest, or "stable"/"main"/"edge" — common moving
// pointers. A digest reference (@sha256:…) is always treated as pinned. Used to surface a quiet
// warning in the drawer so operators can spot images that can drift across restarts.
export function isFloatingImageTag(img: string): boolean {
  if (img.includes('@sha256:')) return false
  // Tag is everything after the last ":" that isn't a port — but registry paths can include a port,
  // e.g. "registry:5000/foo/bar:1.2.3". Split off any path first to make the ":port" case impossible
  // in the segment we inspect.
  const lastSlash = img.lastIndexOf('/')
  const tail = lastSlash >= 0 ? img.slice(lastSlash + 1) : img
  const colon = tail.lastIndexOf(':')
  if (colon < 0) return true // no tag → implicit :latest
  const tag = tail.slice(colon + 1).toLowerCase()
  return tag === 'latest' || tag === 'stable' || tag === 'main' || tag === 'master' || tag === 'edge'
}

// parseImageRef splits an image reference into the registry/path prefix (infra noise — usually the
// same across every container in a cluster), the repository name, and the tag-or-digest. The drawer
// dims the prefix and emphasises the tag so the operator's first question — "which version is
// running?" — reads at a glance instead of hiding at the end of a long ECR/GCR URL. Mirrors the
// registry split in isFloatingImageTag (path first, so a "registry:5000" port is never a false tag).
export function parseImageRef(img: string): { prefix: string; name: string; tag: string } {
  const lastSlash = img.lastIndexOf('/')
  const prefix = lastSlash >= 0 ? img.slice(0, lastSlash + 1) : ''
  const tail = lastSlash >= 0 ? img.slice(lastSlash + 1) : img
  // A digest pin (name@sha256:…) wins over a tag; keep the whole "@sha256:…" as the emphasised part.
  const at = tail.indexOf('@')
  if (at >= 0) return { prefix, name: tail.slice(0, at), tag: tail.slice(at) }
  const colon = tail.indexOf(':')
  if (colon >= 0) return { prefix, name: tail.slice(0, colon), tag: tail.slice(colon) }
  return { prefix, name: tail, tag: '' }
}

// ImageRef renders one image reference — dim registry/path prefix, normal repo name, emphasised
// tag/digest — plus the floating-tag warning and a copy button that yanks the FULL ref. Shared by the
// per-container cards and the workload image list so both read identically (one place to evolve).
export default function ImageRef(props: { image: string; wrapClass: string }) {
  const parts = createMemo(() => parseImageRef(props.image))
  return (
    <div class={props.wrapClass} title={props.image}>
      <code class="image-ref">
        <span class="image-ref-prefix">{parts().prefix}</span>
        {parts().name}
        <span class="image-ref-tag">{parts().tag}</span>
      </code>
      <Show when={isFloatingImageTag(props.image)}>
        <span
          class="image-floating-tag"
          title="No pinned version — a restart may pull a different image"
        >
          floating tag
        </span>
      </Show>
      <CopyButton text={() => props.image} title="Copy image" />
    </div>
  )
}
