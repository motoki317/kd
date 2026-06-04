// Private-mode-safe localStorage access for the `kd:*` display preferences. Reading OR writing
// localStorage can THROW (not just be absent): Safari private mode exposes the object but throws on
// use, and storage can be disabled by policy. App.tsx previously called setItem unguarded inside
// createEffects, so in those browsers every pref change threw and broke reactivity — these helpers
// swallow the failure so a pref simply doesn't persist instead of crashing the app. Centralised so
// the try/catch can't be forgotten at a new call site.

// readPref returns the stored value when it is one of `allowed`, else the fallback — so a corrupt or
// stale key (an old enum value) can never poison a signal. Any access failure yields the fallback.
export function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const v = readRawPref(key)
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

// readRawPref returns the raw stored string (or null) without validation — for callers that parse the
// value themselves (e.g. a comma-separated set). Null on absence OR any access failure.
export function readRawPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// writePref persists a value, silently doing nothing if storage is unavailable/throws.
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage disabled / private mode — the pref just won't persist */
  }
}
