import { describe, expect, it } from 'vitest'
import { splitByMatch } from './logs'
import {
  computeFolds,
  mergeMatchRuns,
  splitManifestLines,
  tokenizeManifest,
  type Token,
  type TokType,
} from './manifestSyntax'

// A marshaled-Deployment-shaped YAML fixture: block-style maps, a "- " sequence, bare scalars, a
// quoted ambiguous scalar ("false"), a number, an empty flow map ({}), and a value with an embedded
// colon (nginx:1.25) and a "#" (a URL) that must NOT be read as a key separator or a comment.
const YAML = `metadata:
  labels:
    app: api-b
  name: api-b
  namespace: shop
spec:
  replicas: 3
  template:
    spec:
      containers:
      - env:
        - name: DEBUG
          value: "false"
        image: nginx:1.25
        livenessProbe:
          httpGet:
            path: /healthz#frag
        name: api-b
        resources: {}
`

// A ConfigMap-shaped YAML fixture exercising a block scalar (key: |) whose indented body — including a
// blank line and a less-indented inner line — is verbatim string content until the next sibling key.
const YAML_BLOCK = `data:
  nginx.conf: |
    server {
      listen 80;

      proxy_pass http://api-b:8080;
    }
  port: "8080"
metadata:
  name: app-config
`

const JSON_SRC = `{
  "metadata": {
    "name": "api-b",
    "labels": {
      "app": "api-b"
    }
  },
  "spec": {
    "replicas": 3,
    "paused": false,
    "strategy": {}
  }
}`

const roundTrip = (text: string, format: 'yaml' | 'json') =>
  tokenizeManifest(text, format)
    .map((t) => t.text)
    .join('')

// Returns the type the tokenizer assigned to the first token whose text equals `text`.
const typeOf = (tokens: Token[], text: string): TokType | undefined => tokens.find((t) => t.text === text)?.type

describe('tokenizeManifest round-trip (the corruption-proof invariant)', () => {
  it('reproduces every YAML fixture byte-for-byte', () => {
    for (const src of [YAML, YAML_BLOCK]) expect(roundTrip(src, 'yaml')).toBe(src)
  })
  it('reproduces the JSON fixture byte-for-byte', () => {
    expect(roundTrip(JSON_SRC, 'json')).toBe(JSON_SRC)
  })
  it('reproduces empty and single-line inputs', () => {
    expect(roundTrip('', 'yaml')).toBe('')
    expect(roundTrip('name: x', 'yaml')).toBe('name: x')
    expect(roundTrip('{}', 'json')).toBe('{}')
  })
})

describe('YAML classification', () => {
  const tokens = tokenizeManifest(YAML, 'yaml')
  it('colors mapping keys as keys', () => {
    expect(typeOf(tokens, 'metadata')).toBe('key')
    expect(typeOf(tokens, 'replicas')).toBe('key')
  })
  it('colors bare and quoted scalar values as strings', () => {
    expect(typeOf(tokens, 'api-b')).toBe('string')
    expect(typeOf(tokens, 'nginx:1.25')).toBe('string') // embedded colon stays inside the value
    expect(typeOf(tokens, '"false"')).toBe('string') // quoted ambiguous scalar is a string, not a keyword
    expect(typeOf(tokens, '/healthz#frag')).toBe('string') // "#" is part of the value, not a comment
  })
  it('colors numbers and structural punctuation', () => {
    expect(typeOf(tokens, '3')).toBe('number')
    expect(typeOf(tokens, ':')).toBe('punct')
    expect(typeOf(tokens, '- ')).toBe('punct')
    expect(typeOf(tokens, '{}')).toBe('punct')
  })
})

describe('YAML block scalars', () => {
  const tokens = tokenizeManifest(YAML_BLOCK, 'yaml')
  it('marks the block indicator as punctuation', () => {
    expect(typeOf(tokens, '|')).toBe('punct')
  })
  it('treats the indented body — including a blank and a less-indented inner line — as string', () => {
    expect(typeOf(tokens, '    server {')).toBe('string')
    expect(typeOf(tokens, '      listen 80;')).toBe('string')
    expect(typeOf(tokens, '      proxy_pass http://api-b:8080;')).toBe('string')
    expect(typeOf(tokens, '    }')).toBe('string')
  })
  it('resumes normal parsing at the next sibling key after the block', () => {
    expect(typeOf(tokens, 'port')).toBe('key')
    expect(typeOf(tokens, '"8080"')).toBe('string')
    expect(typeOf(tokens, 'name')).toBe('key')
  })
})

describe('JSON classification', () => {
  const tokens = tokenizeManifest(JSON_SRC, 'json')
  it('distinguishes object keys from string values', () => {
    expect(typeOf(tokens, '"metadata"')).toBe('key')
    expect(typeOf(tokens, '"api-b"')).toBe('string')
  })
  it('colors numbers, keywords, and punctuation', () => {
    expect(typeOf(tokens, '3')).toBe('number')
    expect(typeOf(tokens, 'false')).toBe('keyword')
    expect(typeOf(tokens, '{')).toBe('punct')
    expect(typeOf(tokens, ',')).toBe('punct')
  })
})

// Sequence-heavy fixture in the exact shape `sigs.k8s.io/yaml` (yaml.v2) emits: sequence items sit at
// the SAME indent as their parent key (containers:/ports:/env: each followed by "- " items at its own
// column), which a naive "next line is deeper" fold rule would miss entirely.
const YAML_SEQ = `spec:
  containers:
  - name: api-b
    ports:
    - containerPort: 8080
    - containerPort: 9090
    env:
    - name: DEBUG
      value: "false"
  - name: sidecar
    image: proxy:1.0
  dnsPolicy: ClusterFirst
`

const headerTexts = (text: string, format: 'yaml' | 'json') => {
  const lines = splitManifestLines(text, format)
  return computeFolds(lines.map((l) => l.text)).map((r) => lines[r.header].text.trim())
}

describe('splitManifestLines', () => {
  it('round-trips every fixture: lines joined by newline reproduce the input', () => {
    for (const [src, fmt] of [
      [YAML, 'yaml'],
      [YAML_BLOCK, 'yaml'],
      [YAML_SEQ, 'yaml'],
      [JSON_SRC, 'json'],
    ] as const) {
      const lines = splitManifestLines(src, fmt)
      expect(lines.map((l) => l.text).join('\n')).toBe(src)
      // each line's own tokens also reproduce the line
      for (const l of lines) expect(l.tokens.map((t) => t.text).join('')).toBe(l.text)
    }
  })
})

describe('computeFolds — YAML sequence-aware regions', () => {
  it('folds block-sequence keys whose items sit at the parent indent', () => {
    const headers = headerTexts(YAML_SEQ, 'yaml')
    // The sections operators most want to collapse — all are "key:" + same-indent "- " items.
    expect(headers).toContain('containers:')
    expect(headers).toContain('ports:')
    expect(headers).toContain('env:')
  })
  it('stops a "- item" header at its next sibling instead of swallowing the rest of the list', () => {
    const lines = splitManifestLines(YAML_SEQ, 'yaml')
    const folds = computeFolds(lines.map((l) => l.text))
    const firstItem = lines.findIndex((l) => l.text === '  - name: api-b')
    const sidecar = lines.findIndex((l) => l.text === '  - name: sidecar')
    const region = folds.find((r) => r.header === firstItem)
    expect(region).toBeDefined()
    expect(region!.end).toBeLessThan(sidecar) // first container's fold ends before the second
  })
  it('folds a block scalar body, including an interior blank line', () => {
    const headers = headerTexts(YAML_BLOCK, 'yaml')
    expect(headers).toContain('nginx.conf: |')
    const lines = splitManifestLines(YAML_BLOCK, 'yaml')
    const folds = computeFolds(lines.map((l) => l.text))
    const header = lines.findIndex((l) => l.text === '  nginx.conf: |')
    const region = folds.find((r) => r.header === header)!
    // the body runs to "    }" (the last block line), spanning the blank line inside it
    expect(lines[region.end].text).toBe('    }')
  })
})

describe('computeFolds — JSON object/array regions', () => {
  it('folds non-empty objects but not one-line empties', () => {
    const headers = headerTexts(JSON_SRC, 'json')
    expect(headers).toContain('"metadata": {')
    expect(headers).toContain('"labels": {')
    expect(headers).toContain('"spec": {')
    expect(headers).not.toContain('"strategy": {}') // empty {} has no body to fold
  })
})

describe('mergeMatchRuns (syntax + search composition)', () => {
  it('reproduces the text and preserves one run per splitByMatch segment', () => {
    const runs = splitByMatch(YAML, 'api-b')
    const merged = mergeMatchRuns(tokenizeManifest(YAML, 'yaml'), runs)
    expect(merged.map((r) => r.spans.map((s) => s.text).join('')).join('')).toBe(YAML)
    expect(merged.filter((r) => r.match).length).toBe(runs.filter((r) => r.match).length)
  })
  it('keeps the syntax type of text under a match, splitting tokens at run boundaries', () => {
    // "app: api-b" spans a key token, ": ", and a value token; a search for the cross-token substring
    // "app: api" must still produce a single match run whose nested spans keep their syntax types.
    const runs = splitByMatch('app: api-b', 'app: api')
    const merged = mergeMatchRuns(tokenizeManifest('app: api-b', 'yaml'), runs)
    const matchRun = merged.find((r) => r.match)
    expect(matchRun?.spans.map((s) => s.text).join('')).toBe('app: api')
    expect(matchRun?.spans.find((s) => s.text === 'app')?.type).toBe('key')
    expect(matchRun?.spans.find((s) => s.text === ':')?.type).toBe('punct')
    expect(matchRun?.spans.find((s) => s.text === 'api')?.type).toBe('string')
  })
  it('returns a single non-match run covering everything when the query is empty', () => {
    const runs = splitByMatch(YAML, '')
    const merged = mergeMatchRuns(tokenizeManifest(YAML, 'yaml'), runs)
    expect(merged.length).toBe(1)
    expect(merged[0].match).toBe(false)
  })
})
