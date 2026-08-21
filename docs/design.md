# UI design

kd lets operators spot, compare, and scan instead of reading every value. User-facing copy should
name the concrete effect ("big things look big"), not call it "intuitive" — and use easy words:
many readers are not native English speakers.

## Audience

kd serves human Kubernetes beginners: they must succeed from the UI alone, without reading long
descriptions or external docs. Judge every candidate change by "does a beginner get it at a
glance?", not by completeness. Pruning serves this as much as adding — remove or fold excess
features and docs, and prefer structural cleanup over one-by-one micro-edits.

## Principles

- **Proximity:** put a value beside what it describes. Each node bar carries its own
  `value / capacity` label.
- **Alignment:** share edges and baselines. Node tracks start at one gutter; "Req" and "Use" align
  against their bars.
- **Repetition:** use one visual language per meaning. Req and Use share colors; every crowded group
  uses the same "+N more" fold.
- **Contrast:** make different states clearly different. Live values use semibold `--text`, capacity
  uses `--text-dim`, and selection stays bright while unrelated elements fade.

Prefer an explicit label, text, or tooltip over an unexplained color or shape: "other namespaces"
is a labeled bar, not a gray bar. Pair icons with text; compact or relocate an overflowing control.

## Design language

- **Typeface follows role.** IBM Plex Sans is chrome/prose. IBM Plex Mono is data an operator may
  paste into a terminal: names, kinds, counts, values, logs, and manifests. Canvas card names remain
  sans because their widths are character-count tuned and mono is about 20% wider.
- **Use type-scale tokens only:** `--fs-caps/meta/body/title` in `web/src/styles/tokens.css`. Readable text is never
  smaller than `--fs-meta` (12.5px); `--fs-caps` is only for uppercase labels. Zoom-coupled SVG text
  is exempt.
- **Use sharp corners:** `--radius-s`/`--radius-m` (2/4px). Do not add pills or capsules;
  `border-radius: 50%` is only for status dots.
- **Keep resting chrome sparse:** search, layout, health, and namespaces. Narrowing facets live in
  Filters; permanent legends do not. A folded control badges active state.
- **Keep four keyboard bindings:** `/`, `↑↓`, `Esc`, `?` (`web/src/appKeyboard.ts`). Every action also has
  a visible, clickable control. Do not add a shortcut without removing one; keep the help card one
  small column.
