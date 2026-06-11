// Imports official Kubernetes resource glyphs into ../src/k8sIconPaths.ts.
//
// Source is Argo CD's resource icon set (ui/src/assets/images/resources, Apache-2.0 — see
// NOTICE): the upstream Kubernetes Icons Set artwork with the heptagon frame already removed,
// leaving the tightly-cropped inner glyph users know from the Argo CD resource tree. kd renders
// icons as monochrome fragments in a shared 14x14 viewBox, so this script flattens each file
// (transforms applied, inherited <g> paints resolved), fits it into the shared box, and replaces
// the flat #8fa4b1 fill with currentColor so the surrounding UI controls the color.
//
// Pinned to a commit SHA (not a branch) so a regeneration years later still produces the same
// artwork the NOTICE attribution was written for.
//
// Usage: node web/scripts/import-k8s-icons.mjs   (network access required)

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import svgpath from 'svgpath'

const ARGO_SHA = '0dd887435f92a54650949bad3ab611a1b179fe8d'
const ARGO_BASE = `https://raw.githubusercontent.com/argoproj/argo-cd/${ARGO_SHA}/ui/src/assets/images/resources`

// kd kind -> Argo CD file. Kinds absent here (Node, APIService, CSI*, webhook configurations,
// PDB, PriorityClass) have no upstream glyph and keep kd's own stroke glyphs in icons.tsx —
// Argo CD's app tree never shows a Node, so its set has none, and the Kubernetes Icons Set's
// node pictogram is a heptagon that reads as k8s branding rather than "a machine".
const KIND_TO_FILE = {
  Pod: 'pod.svg',
  Service: 'svc.svg',
  Namespace: 'ns.svg',
  ConfigMap: 'cm.svg',
  Secret: 'secret.svg',
  PersistentVolumeClaim: 'pvc.svg',
  ServiceAccount: 'sa.svg',
  Endpoints: 'ep.svg',
  Deployment: 'deploy.svg',
  ReplicaSet: 'rs.svg',
  StatefulSet: 'sts.svg',
  DaemonSet: 'ds.svg',
  Job: 'job.svg',
  CronJob: 'cronjob.svg',
  Ingress: 'ing.svg',
  Role: 'role.svg',
  RoleBinding: 'rb.svg',
  ClusterRole: 'c-role.svg',
  ClusterRoleBinding: 'crb.svg',
  PersistentVolume: 'pv.svg',
  CustomResourceDefinition: 'crd.svg',
  StorageClass: 'sc.svg',
  HorizontalPodAutoscaler: 'hpa.svg',
  NetworkPolicy: 'netpol.svg',
  ResourceQuota: 'quota.svg',
  LimitRange: 'limits.svg',
  User: 'user.svg',
  Group: 'group.svg',
}

// Glyph max dimension inside the 14x14 box — sized so filled official glyphs read at the same
// optical weight as kd's stroke glyphs (which span ~10 units).
const TARGET = 11.2

const IDENTITY = [1, 0, 0, 1, 0, 0]

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

function parseTransform(str) {
  let m = IDENTITY
  if (!str) return m
  for (const [, fn, argStr] of str.matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
    const a = argStr.split(/[\s,]+/).filter(Boolean).map(Number)
    if (fn === 'matrix') m = mul(m, a)
    else if (fn === 'translate') m = mul(m, [1, 0, 0, 1, a[0], a[1] ?? 0])
    else if (fn === 'scale') m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0])
    else if (fn === 'rotate') {
      const r = (a[0] * Math.PI) / 180
      const rot = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0]
      m = mul(m, mul(mul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]))
    } else throw new Error(`unsupported transform ${fn}`)
  }
  return m
}

function parseAttrs(tag) {
  const attrs = {}
  for (const [, k, v] of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g)) attrs[k] = v
  return attrs
}

// SVG paint properties inherit from ancestor <g> elements; resolve presentation attributes, then
// the style attribute (the priority order the SVG cascade defines), over the inherited base.
const PAINT_DEFAULTS = {
  fill: '#000000',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-opacity': '1',
  'stroke-width': '1',
  'stroke-dasharray': 'none',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
}

function resolveStyle(attrs, base) {
  const s = { ...base, display: 'inline' }
  for (const k of Object.keys(PAINT_DEFAULTS)) if (attrs[k] !== undefined) s[k] = attrs[k]
  if (attrs.display !== undefined) s.display = attrs.display
  for (const decl of (attrs.style ?? '').split(';')) {
    const i = decl.indexOf(':')
    if (i === -1) continue
    const k = decl.slice(0, i).trim()
    if (k in PAINT_DEFAULTS || k === 'display') s[k] = decl.slice(i + 1).trim()
  }
  return s
}

const rectPath = (a) => {
  const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(a[k] ?? 0))
  let rx = a.rx !== undefined ? Number(a.rx) : a.ry !== undefined ? Number(a.ry) : 0
  let ry = a.ry !== undefined ? Number(a.ry) : rx
  rx = Math.min(rx, w / 2)
  ry = Math.min(ry, h / 2)
  if (rx <= 0 || ry <= 0) return `M ${x} ${y} h ${w} v ${h} h ${-w} z`
  return (
    `M ${x + rx} ${y} h ${w - 2 * rx} a ${rx} ${ry} 0 0 1 ${rx} ${ry} v ${h - 2 * ry}` +
    ` a ${rx} ${ry} 0 0 1 ${-rx} ${ry} h ${-(w - 2 * rx)} a ${rx} ${ry} 0 0 1 ${-rx} ${-ry}` +
    ` v ${-(h - 2 * ry)} a ${rx} ${ry} 0 0 1 ${rx} ${-ry} z`
  )
}

const ellipsePath = (a) => {
  const cx = Number(a.cx ?? 0)
  const cy = Number(a.cy ?? 0)
  const rx = Number(a.rx ?? a.r)
  const ry = Number(a.ry ?? a.r)
  return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${2 * rx} 0 a ${rx} ${ry} 0 1 0 ${-2 * rx} 0 z`
}

// Parses an SVG into paint ops flattened to viewBox coordinates, original colors preserved.
function parseSvg(svgText) {
  const text = svgText.replace(/<!--[\s\S]*?-->/g, '')
  const viewBox = (parseAttrs(text.match(/<svg([^>]*)>/)[1]).viewBox ?? '')
    .split(/[\s,]+/)
    .map(Number)
  if (viewBox.length !== 4) throw new Error('missing viewBox')
  const stack = [{ m: IDENTITY, style: PAINT_DEFAULTS }]
  let skip = 0
  const ops = []
  for (const [, closing, name, body = '', selfClose] of text.matchAll(
    /<(\/?)([a-zA-Z:]+)((?:[^<>"]|"[^"]*")*?)(\/?)>/g,
  )) {
    if (name === 'defs' || name === 'metadata') {
      if (closing) skip--
      else if (!selfClose) skip++
      continue
    }
    if (skip > 0) continue
    if (name === 'g') {
      if (closing) stack.pop()
      else if (!selfClose) {
        const attrs = parseAttrs(body)
        const top = stack.at(-1)
        stack.push({
          m: mul(top.m, parseTransform(attrs.transform)),
          style: resolveStyle(attrs, top.style),
        })
      }
      continue
    }
    if (closing || !['path', 'rect', 'circle', 'ellipse'].includes(name)) continue

    const attrs = parseAttrs(body)
    const top = stack.at(-1)
    const s = resolveStyle(attrs, top.style)
    if (s.display === 'none') continue
    const fills = s.fill !== 'none' && Number(s['fill-opacity']) > 0
    const strokes =
      s.stroke !== 'none' && Number(s['stroke-opacity']) > 0 && Number(s['stroke-width']) > 0
    if (!fills && !strokes) continue

    const m = mul(top.m, parseTransform(attrs.transform))
    const raw = name === 'path' ? attrs.d : name === 'rect' ? rectPath(attrs) : ellipsePath(attrs)
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
    const op = { d: svgpath(raw).matrix(m).toString() }
    if (fills) {
      op.fill = s.fill
      if (s['fill-rule'] === 'evenodd') op.fillRule = 'evenodd'
    }
    if (strokes) {
      op.stroke = s.stroke
      op.strokeWidth = Number(s['stroke-width']) * scale
      if (s['stroke-dasharray'] !== 'none')
        op.strokeDasharray = s['stroke-dasharray']
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((v) => Number(v) * scale)
      if (s['stroke-linecap'] !== 'butt') op.strokeLinecap = s['stroke-linecap']
      if (s['stroke-linejoin'] !== 'miter') op.strokeLinejoin = s['stroke-linejoin']
    }
    ops.push(op)
  }
  return { viewBox, ops }
}

const round3 = (v) => Math.round(v * 1000) / 1000

// The Argo CD artwork assumes a white canvas: white (or near-white) fills make stacked shapes
// occlude the ones behind them, and thin white strokes engrave detail lines. kd cards are
// health-tinted, so literal white would leave visible patches — instead a white paint becomes a
// `hole` primitive, which the renderer turns into a transparency mask over everything painted
// before it (the card background shows through, whatever its tint).
const isBackgroundPaint = (c) => /^(#fff(fff)?|#eee(eee)?|#fffff0|white)$/i.test(c)

// Fits ops into the shared 14x14 box (glyph max dimension = TARGET, centered) and recolors to
// currentColor, letting the surrounding UI drive the icon color. Each op splits into fill-then-
// stroke primitives (SVG paint order), so a white detail stroke can knock out its own op's fill.
function finalize(ops, box) {
  const s = TARGET / Math.max(box[2], box[3])
  const m = [s, 0, 0, s, (14 - box[2] * s) / 2 - box[0] * s, (14 - box[3] * s) / 2 - box[1] * s]
  const prims = []
  for (const op of ops) {
    const d = svgpath(op.d).matrix(m).round(3).toString()
    if (op.fill) {
      const p = { d }
      if (isBackgroundPaint(op.fill)) p.hole = true
      p.fill = 'currentColor'
      if (op.fillRule) p.fillRule = op.fillRule
      prims.push(p)
    }
    if (op.stroke) {
      const p = { d }
      if (isBackgroundPaint(op.stroke)) p.hole = true
      p.stroke = 'currentColor'
      p.strokeWidth = round3(op.strokeWidth * s)
      if (op.strokeDasharray) p.strokeDasharray = op.strokeDasharray.map((v) => round3(v * s)).join(' ')
      if (op.strokeLinecap) p.strokeLinecap = op.strokeLinecap
      if (op.strokeLinejoin) p.strokeLinejoin = op.strokeLinejoin
      prims.push(p)
    }
  }
  return prims
}

const fetchText = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

const glyphs = {}
for (const [kind, file] of Object.entries(KIND_TO_FILE)) {
  const { viewBox, ops } = parseSvg(await fetchText(`${ARGO_BASE}/${file}`))
  glyphs[kind] = finalize(ops, viewBox)
  const holes = glyphs[kind].filter((p) => p.hole).length
  console.log(`${kind}: ${glyphs[kind].length} primitives${holes ? ` (${holes} holes)` : ''}`)
}

const tsLiteral = (op) =>
  '    {\n' +
  Object.entries(op)
    .map(([k, v]) => `      ${k}: ${typeof v === 'string' ? `'${v}'` : v},`)
    .join('\n') +
  '\n    },'

const out = `// GENERATED by web/scripts/import-k8s-icons.mjs — do not edit by hand.
//
// Artwork: Argo CD resource icons, argoproj/argo-cd@${ARGO_SHA.slice(0, 12)}
// (© The Argo Project Authors, Apache-2.0), themselves derived from the Kubernetes Icons Set
// (© The Kubernetes Authors). Attribution and license text in NOTICE at the repo root. Each
// glyph is flattened, scaled into kd's shared 14x14 icon viewBox, and recolored to currentColor
// so the surrounding UI drives the icon color.
//
// A primitive paints EITHER its fill or its stroke (ops are split in SVG paint order). hole: true
// marks paint that is white in the upstream artwork, where it relies on a white canvas to occlude
// stacked shapes or engrave detail lines — the renderer must erase that region from everything
// painted before it (a transparency mask), not paint it, so kd's health-tinted card backgrounds
// show through. The fill/stroke field on a hole tells which kind of region to erase.

export type K8sIconPaint = {
  d: string
  hole?: boolean
  fill?: string
  fillRule?: 'evenodd'
  stroke?: string
  strokeWidth?: number
  strokeDasharray?: string
  strokeLinecap?: 'round' | 'square'
  strokeLinejoin?: 'round' | 'bevel'
}

export const K8S_ICONS: Record<string, K8sIconPaint[]> = {
${Object.entries(glyphs)
  .map(([k, ops]) => `  ${k}: [\n${ops.map(tsLiteral).join('\n')}\n  ],`)
  .join('\n')}
}
`

const dest = join(dirname(fileURLToPath(import.meta.url)), '../src/k8sIconPaths.ts')
writeFileSync(dest, out)
console.log(`wrote ${dest} (${Object.keys(glyphs).length} kinds)`)
