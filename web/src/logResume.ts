import type { LogEntry } from './api'

// LogViewer keeps at most this many lines, and the resume tracks at most this many sources, so a
// source it forgets has no line left on screen.
export const LOG_BUFFER_CAPACITY = 2001

interface SourceResume {
  stamp: string
  lines: Map<string, number>
}

// createLogResume drops the lines kd re-sends after a log stream reconnects. The server's replay
// filter (logResume in internal/api/logstream.go) lasts one connection, so the client, which holds
// the displayed lines, applies the same rule across connections: at the last stamp, drop each text
// only as often as it was shown. Skipping the first N lines at that stamp instead would drop a new
// line once the re-sent tail starts later. Kubelet stamps are fixed-width, so string order is time
// order within one container.
export function createLogResume() {
  const live = new Map<string, SourceResume>()
  let delivered = new Map<string, SourceResume>()

  return {
    opened() {
      delivered = structuredClone(live)
    },
    accept(entry: LogEntry): boolean {
      const source = `${entry.pod}/${entry.container ?? ''}`
      const snapshot = delivered.get(source)
      if (snapshot && entry.time) {
        if (entry.time < snapshot.stamp) return false
        const remaining = snapshot.lines.get(entry.line) ?? 0
        if (entry.time === snapshot.stamp && remaining > 0) {
          snapshot.lines.set(entry.line, remaining - 1)
          return false
        }
      }

      let resume = live.get(source)
      if (entry.time) {
        if (!resume || entry.time > resume.stamp) {
          resume = { stamp: entry.time, lines: new Map() }
        }
        if (entry.time === resume.stamp) {
          resume.lines.set(entry.line, (resume.lines.get(entry.line) ?? 0) + 1)
        }
      }
      if (resume) {
        // Re-inserting keeps the Map ordered from least to most recently accepted source.
        live.delete(source)
        live.set(source, resume)
        if (live.size > LOG_BUFFER_CAPACITY) {
          // The first source has at least LOG_BUFFER_CAPACITY later accepted lines, so LogViewer's
          // buffer holds none of its lines, and its replay cannot duplicate a visible one.
          live.delete(live.keys().next().value!)
        }
      }
      return true
    },
  }
}
