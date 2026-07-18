import { Show } from 'solid-js'

interface Props {
  connected: boolean
  offline?: boolean
  noAccess?: boolean
  authFailed?: boolean
  offlineReason?: string
  // The "current lens" hint (grouping + relationships) shown when the stream is live but the
  // canvas is empty — computed by the parent, which owns the groupBy/relFilter state.
  hint: string
}

// The canvas empty-state ladder, lifted from Topology.tsx. Purely presentational: the parent gates
// rendering on an empty node set and passes the connection/identity flags through unchanged.
export default function CanvasEmpty(props: Props) {
  return (
    <div class="topology-empty">
      {/* Friendly graphic: three card silhouettes staggered like a small cluster, each with a
          tiny icon-circle hint at the top-left echoing the icon-forward card. */}
      <svg class="topology-empty-illo" viewBox="0 0 140 64" width="140" height="64" aria-hidden="true">
        <g>
          <rect x="6" y="22" width="36" height="22" rx="5" class="empty-card" />
          <circle cx="14" cy="32" r="2.6" class="empty-card-icon" />
        </g>
        <g>
          <rect x="50" y="12" width="36" height="22" rx="5" class="empty-card" />
          <circle cx="58" cy="22" r="2.6" class="empty-card-icon" />
        </g>
        <g>
          <rect x="94" y="26" width="36" height="22" rx="5" class="empty-card" />
          <circle cx="102" cy="36" r="2.6" class="empty-card-icon" />
        </g>
      </svg>
      {/* role=status: the connecting→offline/no-access/not-signed-in transitions must be
          announced — the conn pill (the other live region) HIDES in the identity states, so
          without this a screen reader hears nothing when the canvas reaches its terminal
          answer. */}
      <div class="topology-empty-text" role="status">
        <Show when={props.connected} fallback={
          // Rung order: auth > no-access > offline > connecting. Identity failures outrank
          // connectivity ones — with zero visible namespaces or no identity at all, "can't
          // reach the cluster" misdiagnoses what is actually a permissions answer.
          <Show when={props.authFailed} fallback={
          <Show when={props.noAccess} fallback={
            <Show when={props.offline} fallback={
              <>
                {/* Small inline spinner so "Connecting…" reads as "actively working on it" rather
                    than a frozen text state. CSS animation; respects prefers-reduced-motion. */}
                <span class="topology-empty-spinner" aria-hidden="true" />
                Connecting…
              </>
            }>
              {/* Offline with no data (e.g. an unreachable context): a static message, NOT the
                  spinner — the connection failed, so point at the retry control rather than
                  implying progress. */}
              Can't reach the cluster — use “offline · retry” above to reconnect.
              {/* The server-reported reason (when the context's cache failed to build): a Go error
                  chain whose TAIL names the root cause ("getting credentials: exec: …"), telling
                  an expired-SSO operator the fix is a login, not another retry. Dim and clamped —
                  diagnosis, not the headline; the full chain stays in the title. */}
              <Show when={props.offlineReason}>
                <div class="topology-empty-reason" title={props.offlineReason}>{props.offlineReason}</div>
              </Show>
            </Show>
          }>
            No namespaces are visible to this account — ask whoever runs kd to grant access.
          </Show>
          }>
            Not signed in — kd received no identity from its auth proxy, or access is denied.
          </Show>
        }>
          Nothing to show in this namespace.
        </Show>
      </div>
      {/* When the canvas is empty but the stream is live, surface a hint describing the current
          grouping / relationship selection, so the operator understands the lens they're
          looking through. Hidden while connecting (the line above carries the message). */}
      <Show when={props.connected}>
        <div class="topology-empty-hint">{props.hint}</div>
      </Show>
    </div>
  )
}
