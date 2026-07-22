/**
 * Grouping of Citations into table rows and export formats.
 * Row key = (law, kind, number) — the same unit the staleness check uses.
 */
import type { Citation, Modifier, TableRow } from './models'
import { canonical } from './models'
import { normalizeCodeKey } from './extractor'

/**
 * How far an open-ended "ff." citation is assumed to reach beyond its start
 * (juristic convention: the following provisions of the same topic — usually
 * well under 20). "f." reaches exactly one § further.
 */
export const FF_REACH = 20

/**
 * Ranges spanning more norms than this are not verified individually —
 * they go to the self-review table ("§§ 433–853" would mean ~421 checks).
 */
export const RANGE_VERIFY_LIMIT = 10

/** Numeric span [from, to] covered by a range/f./ff. citation, else null. */
function coveredSpan(c: Citation): [number, number] | null {
  const start = parseInt(c.ref.number, 10)
  if (c.ref.numberEnd) return [start, parseInt(c.ref.numberEnd, 10)]
  if (c.ref.ff === 'f.') return [start, start + 1]
  if (c.ref.ff === 'ff.') return [start, start + FF_REACH]
  return null
}

function addPageSource(row: TableRow, page: number, raw: string): void {
  const list = (row.pageSources[page] ??= [])
  if (!list.includes(raw)) list.push(raw)
}

export function groupCitations(citations: Citation[]): TableRow[] {
  const rows = new Map<string, TableRow & { _explicitSeen: boolean }>()

  for (const c of citations) {
    const law = c.verweis ? '[Verweis]' : (c.lawCode ?? '[?]')
    // Key by the NORMALIZED code so casing/punctuation variants of one law
    // merge ("ProdHaftG"/"ProdhaftG"); display keeps the shortest variant.
    // ff.-citations and ranges get their own rows (they need different
    // verification and live in the self-review table when unbounded/wide).
    const lawKey = c.verweis ? '[Verweis]' : c.lawCode ? normalizeCodeKey(c.lawCode) : '[?]'
    const key =
      `${lawKey} ${c.ref.kind} ${c.ref.number}` +
      (c.ref.numberEnd ? `-${c.ref.numberEnd}` : '') +
      (c.ref.ff === 'ff.' ? ' ff.' : '')
    let row = rows.get(key)
    if (row && law !== '[?]' && law.length < row.law.length) row.law = law
    if (!row) {
      row = {
        law,
        kind: c.ref.kind,
        number: c.ref.number,
        numberEnd: c.ref.numberEnd,
        ff: c.ref.ff === 'ff.' ? 'ff.' : undefined,
        variants: [],
        pages: [],
        impliedPages: [],
        implicitOnly: true,
        modifiers: [],
        pageSources: {},
        _explicitSeen: false,
      }
      rows.set(key, row)
    }
    const v = canonical(c)
    if (!row.variants.includes(v)) row.variants.push(v)
    if (!row.pages.includes(c.page)) row.pages.push(c.page)
    addPageSource(row, c.page, c.raw)
    if (!c.implicit && c.lawCode) row._explicitSeen = true
    if (c.ref.ff === 'f.') row.ff = 'f.'
    for (const m of c.modifiers) if (!row.modifiers.includes(m)) row.modifiers.push(m)
  }

  // Second pass: a range/ff. citation also covers every OTHER row whose §
  // falls inside its span ("§§ 812–822" covers § 815; "§ 123 ff." covers
  // § 124 …). Those pages are recorded as implied.
  for (const c of citations) {
    const span = coveredSpan(c)
    if (!span) continue
    const lawKey = c.lawCode ? normalizeCodeKey(c.lawCode) : '[?]'
    for (const row of rows.values()) {
      const rowKey = row.law === '[?]' ? '[?]' : normalizeCodeKey(row.law)
      if (rowKey !== lawKey || row.kind !== c.ref.kind) continue
      if (
        row.number === c.ref.number &&
        row.numberEnd === c.ref.numberEnd &&
        (row.ff === 'ff.') === (c.ref.ff === 'ff.')
      )
        continue // own row
      const n = parseInt(row.number, 10)
      if (n >= span[0] && n <= span[1]) {
        if (!row.impliedPages.includes(c.page)) row.impliedPages.push(c.page)
        addPageSource(row, c.page, c.raw)
      }
    }
  }

  const out: TableRow[] = []
  for (const row of rows.values()) {
    row.implicitOnly = row.law !== '[?]' && !row._explicitSeen
    row.pages.sort((a, b) => a - b)
    row.impliedPages = row.impliedPages.filter((p) => !row.pages.includes(p)).sort((a, b) => a - b)
    row.variants.sort(compareVariant)
    const { _explicitSeen, ...clean } = row
    out.push(clean)
  }

  out.sort((a, b) => {
    if (a.law !== b.law) return a.law === '[?]' ? 1 : b.law === '[?]' ? -1 : a.law.localeCompare(b.law, 'de')
    if (a.kind !== b.kind) return a.kind === '§' ? -1 : 1
    return compareSectionNumber(a.number, b.number)
  })
  return out
}

/** Numeric-aware compare: "812" < "823", "306" < "306a" < "307". */
export function compareSectionNumber(a: string, b: string): number {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  if (na !== nb) return na - nb
  return a.localeCompare(b, 'de')
}

function compareVariant(a: string, b: string): number {
  return a.localeCompare(b, 'de', { numeric: true })
}

/**
 * Severity for result ordering: confirmed changes first, then everything
 * ambiguous (law-level only, possibly stale, unchecked), then norms that are
 * confirmed current. Rows without staleness data rank last.
 */
function staleSeverity(row: TableRow): number {
  switch (row.staleness?.status) {
    case 'PARA_CHANGED':
      return 0
    case 'LAW_CHANGED':
      return 1
    case 'POSSIBLY_STALE':
      return 2
    case 'UNKNOWN':
      return 3
    case 'PARA_UNCHANGED':
    case 'UNCHANGED':
      return 4
    default:
      return 5
  }
}

/** Re-sorts rows in place after the staleness check: changed → ambiguous → current. */
export function sortRowsByStaleness(rows: TableRow[]): void {
  rows.sort((a, b) => {
    const s = staleSeverity(a) - staleSeverity(b)
    if (s !== 0) return s
    if (a.law !== b.law) return a.law === '[?]' ? 1 : b.law === '[?]' ? -1 : a.law.localeCompare(b.law, 'de')
    if (a.kind !== b.kind) return a.kind === '§' ? -1 : 1
    return compareSectionNumber(a.number, b.number)
  })
}

/** Display label for the Norm column: "§ 823", "§§ 433–853", "§ 104 ff.". */
export function normLabel(row: TableRow): string {
  let label: string
  if (row.numberEnd) {
    label = `${row.kind === '§' ? '§§' : 'Artt.'} ${row.number}–${row.numberEnd}`
  } else {
    label = `${row.kind} ${row.number}`
  }
  if (row.ff === 'ff.') label += ' ff.'
  return label
}

/** Width of the numeric span a row claims to cover (1 for single norms). */
export function rowSpanWidth(row: TableRow): number {
  return row.numberEnd ? parseInt(row.numberEnd, 10) - parseInt(row.number, 10) + 1 : 1
}

/**
 * Splits rows into the precisely verifiable main table, the self-review
 * table (open-ended ff. citations and ranges wider than RANGE_VERIFY_LIMIT),
 * and literature/chapter references ("Verweise").
 */
export function splitRows(rows: TableRow[]): {
  main: TableRow[]
  review: TableRow[]
  verweise: TableRow[]
} {
  const main: TableRow[] = []
  const review: TableRow[] = []
  const verweise: TableRow[] = []
  for (const row of rows) {
    if (row.law === '[Verweis]') verweise.push(row)
    else if (row.ff === 'ff.' || rowSpanWidth(row) > RANGE_VERIFY_LIMIT) review.push(row)
    else main.push(row)
  }
  return { main, review, verweise }
}

// --- exports ---

const STATUS_LABEL: Record<string, string> = {
  PARA_CHANGED: 'Norm geändert',
  PARA_UNCHANGED: 'Norm unverändert',
  LAW_CHANGED: 'Gesetz geändert',
  POSSIBLY_STALE: 'evtl. geändert',
  UNCHANGED: 'unverändert',
  UNKNOWN: 'nicht geprüft',
}

export function statusLabel(row: TableRow): string {
  return row.staleness ? (STATUS_LABEL[row.staleness.status] ?? row.staleness.status) : ''
}

/** "3, 7, 12*" — implied pages (via range/ff. citation) carry a * marker. */
function pagesText(row: TableRow): string {
  const all = [
    ...row.pages.map((p) => ({ p, implied: false })),
    ...row.impliedPages.map((p) => ({ p, implied: true })),
  ].sort((a, b) => a.p - b.p)
  return all.map((e) => (e.implied ? `${e.p}*` : `${e.p}`)).join(', ')
}

function csvEscape(v: string): string {
  return /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Semicolon-separated CSV (German Excel default). */
export function toCsv(rows: TableRow[]): string {
  const { main, review, verweise } = splitRows(rows)
  const header = ['Kategorie', 'Gesetz', 'Norm', 'Zitat-Varianten', 'Seiten', 'Status', 'Hinweis']
  const lines = [header.join(';')]
  const push = (r: TableRow, kategorie: string) =>
    lines.push(
      [
        kategorie,
        r.law + (r.implicitOnly ? ' (implizit)' : ''),
        normLabel(r),
        r.variants.join(' | '),
        pagesText(r),
        statusLabel(r),
        r.staleness?.note ?? '',
      ]
        .map(csvEscape)
        .join(';'),
    )
  for (const r of main) push(r, 'geprüft')
  for (const r of review) push(r, 'selbst prüfen')
  for (const r of verweise) push(r, 'Verweis')
  return '﻿' + lines.join('\r\n') // BOM so Excel detects UTF-8
}

export function toMarkdown(rows: TableRow[], title: string): string {
  const { main, review, verweise } = splitRows(rows)
  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const tableOf = (list: TableRow[]) => [
    '| Gesetz | Norm | Zitat-Varianten | Seiten | Status | Hinweis |',
    '|---|---|---|---|---|---|',
    ...list.map(
      (r) =>
        `| ${esc(r.law)}${r.implicitOnly ? ' *(implizit)*' : ''} | ${normLabel(r)} | ${esc(
          r.variants.join('; '),
        )} | ${pagesText(r)} | ${statusLabel(r)} | ${esc(r.staleness?.note ?? '')} |`,
    ),
  ]
  const lines = [`# ParagraphenSuche – ${title}`, '', ...tableOf(main)]
  if (review.length > 0) {
    lines.push('', '## Bereichszitate & „ff.“ – bitte selbst prüfen', '', ...tableOf(review))
  }
  if (verweise.length > 0) {
    lines.push('', '## Literatur- & Kapitelverweise', '', ...tableOf(verweise))
  }
  return lines.join('\n') + '\n'
}

export function toHtml(rows: TableRow[], title: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const { main, review, verweise } = splitRows(rows)
  const tableOf = (list: TableRow[]) => `<table><thead><tr><th>Gesetz</th><th>Norm</th><th>Zitat-Varianten</th><th>Seiten</th><th>Status</th><th>Hinweis</th></tr></thead>
<tbody>
${list
  .map(
    (r) => `<tr>
  <td>${esc(r.law)}${r.implicitOnly ? ' <em>(implizit)</em>' : ''}</td>
  <td>${esc(normLabel(r))}</td>
  <td>${esc(r.variants.join('; '))}</td>
  <td>${pagesText(r)}</td>
  <td>${esc(statusLabel(r))}</td>
  <td>${esc(r.staleness?.note ?? '')}</td>
</tr>`,
  )
  .join('\n')}
</tbody></table>`
  const reviewSection =
    review.length > 0
      ? `<h2>Bereichszitate &amp; „ff.“ – bitte selbst prüfen</h2>\n${tableOf(review)}`
      : ''
  const verweisSection =
    verweise.length > 0 ? `<h2>Literatur- &amp; Kapitelverweise</h2>\n${tableOf(verweise)}` : ''
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>ParagraphenSuche – ${esc(title)}</title>
<style>body{font-family:sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
th{background:#e8f0f8}</style></head><body>
<h1>ParagraphenSuche – ${esc(title)}</h1>
${tableOf(main)}
${reviewSection}
${verweisSection}
</body></html>
`
}
