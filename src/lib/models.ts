/** Kind of norm reference: German statute section or article. */
export type Kind = '§' | 'Art.'

/** One element of the subdivision chain, in citation order. */
export interface Detail {
  /** '§' covers the EGBGB pattern "Art. 246a § 1 Abs. 2 S. 2 EGBGB". */
  level: '§' | 'Abs.' | 'S.' | 'Hs.' | 'Nr.' | 'lit.' | 'Alt.' | 'Var.' | 'Doppelbuchst.'
  /** Normalized value, e.g. "1", "1 und 2", "3-5", "f". */
  value: string
}

/** A single norm within a citation (enumerations/iVm chains expand to several). */
export interface NormRef {
  kind: Kind
  /** Section/article number as written, e.g. "823", "306a". */
  number: string
  /** End of a range ("§§ 12–15"), if any. */
  numberEnd?: string
  /** Open-ended continuation: "f." (one following) or "ff." (several). */
  ff?: 'f.' | 'ff.'
  details: Detail[]
}

export type Modifier = 'a.F.' | 'n.F.' | 'analog' | 'entsprechend' | 'Rn-context'

export interface Citation {
  /** Exact matched text span (debugging / warnings). */
  raw: string
  /** 1-based PDF page number. */
  page: number
  ref: NormRef
  /** Law code as attached (written or implicit), e.g. "BGB", "SGB V", "DSGVO". */
  lawCode?: string
  /** True when lawCode came from the user-supplied implicit code. */
  implicit: boolean
  modifiers: Modifier[]
  /** Citations joined by "iVm" share a chain id (display only). */
  chainId?: number
}

export type StaleStatus =
  | 'PARA_CHANGED' // the cited § itself changed after the document year (confirmed)
  | 'PARA_UNCHANGED' // the cited § is textually identical to the document-year version
  | 'LAW_CHANGED' // the law as a whole was amended after the document year (per-§ unknown)
  | 'POSSIBLY_STALE' // the law was amended within the document year itself
  | 'UNCHANGED' // no amendment after the document year
  | 'UNKNOWN' // unresolved code, EU instrument, or check unavailable

export interface StalenessResult {
  status: StaleStatus
  lawLastAmended?: string // ISO date
  /** Human-readable German note for the table. */
  note: string
}

/** One row of the output table; key = (law, kind, number). */
export interface TableRow {
  law: string // display code, "[?]" when unresolved
  kind: Kind
  number: string
  /** Distinct canonical citation strings seen, e.g. ["§ 812 Abs. 1 S. 1 BGB", "§ 812 BGB"]. */
  variants: string[]
  /** Sorted, deduplicated 1-based page numbers. */
  pages: number[]
  /**
   * Pages where this § is covered only implicitly by a range or ff. citation
   * ("§§ 812–822" also covers § 815; "§ 123 ff." covers the following §§).
   * Rendered with a * marker.
   */
  impliedPages: number[]
  /** True when the law code was never written out, only implicit. */
  implicitOnly: boolean
  modifiers: Modifier[]
  staleness?: StalenessResult
  /**
   * Per page: the raw citation snippets that put this page in the row
   * (for implied pages, the covering range/ff. citation). Drives the
   * page-preview highlighting.
   */
  pageSources: Record<number, string[]>
}

export interface AnalysisWarning {
  page?: number
  message: string
}

export interface AnalysisResult {
  rows: TableRow[]
  warnings: AnalysisWarning[]
  stats: {
    pages: number
    citations: number
    unresolvedCodes: string[]
  }
}

const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 }

/** Convert a Roman numeral (I, IV, XII, …) to its arabic value. */
export function romanToArabic(roman: string): number {
  let total = 0
  for (let i = 0; i < roman.length; i++) {
    const cur = ROMAN_VALUES[roman[i]!] ?? 0
    const next = ROMAN_VALUES[roman[i + 1] ?? ''] ?? 0
    total += cur < next ? -cur : cur
  }
  return total
}

/** Canonical citation string, e.g. "§ 812 Abs. 1 S. 1 Alt. 1 BGB". */
export function canonical(c: Citation): string {
  const parts: string[] = []
  const sign = c.ref.numberEnd ? (c.ref.kind === '§' ? '§§' : 'Artt.') : c.ref.kind
  let num = `${sign} ${c.ref.number}`
  if (c.ref.numberEnd) num += `–${c.ref.numberEnd}`
  if (c.ref.ff) num += ` ${c.ref.ff}`
  parts.push(num)
  for (const d of c.ref.details) parts.push(`${d.level} ${d.value}`)
  for (const m of c.modifiers) if (m !== 'Rn-context') parts.push(m)
  if (c.lawCode) parts.push(c.lawCode)
  return parts.join(' ')
}
