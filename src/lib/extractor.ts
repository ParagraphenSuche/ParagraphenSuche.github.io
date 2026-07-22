/**
 * Pipeline orchestration: cleaned pages -> validated Citations.
 * Code validation is injected (the real registry arrives with the
 * staleness feature; tests and the offline path use a static set).
 */
import type { AnalysisWarning, Citation, Modifier } from './models'
import { cleanText, stripRepeatedEdges } from './textclean'
import { findCitations } from './grammar'
import aliasData from '../data/aliases.json'

export type CodeVerdict = 'known' | 'reject' | 'unknown'

export interface ExtractOptions {
  implicitCode?: string
  dropRnContext?: boolean
  /** Validates a written code candidate. */
  checkCode: (code: string) => CodeVerdict
}

export interface ExtractResult {
  citations: Citation[]
  warnings: AnalysisWarning[]
  unresolvedCodes: Map<string, number> // candidate -> occurrences
}

const REJECT = new Set((aliasData.reject as string[]).map((r) => normalizeCodeKey(r)))

/** Normalization used for all code comparisons: casefold, strip spaces/dots/hyphens. */
export function normalizeCodeKey(code: string): string {
  return code.toLowerCase().replace(/[\s.\-–]/g, '')
}

export function isRejectedCode(code: string): boolean {
  return REJECT.has(normalizeCodeKey(code))
}

/** Highest § numbers are ~2400 (BGB 2385); anything larger is header/footnote junk. */
const MAX_SECTION = 2500

const RN_AFTER_RE = /^\s*(?:Rn|Rdnr|Rz|Rnr)\.?\s*\d/

export function extractFromPages(pages: string[], opts: ExtractOptions): ExtractResult {
  const citations: Citation[] = []
  const warnings: AnalysisWarning[] = []
  const unresolved = new Map<string, number>()

  // Strip repeated headers/footers, then join all pages into one text so
  // citations straddling a page break ("… nach § 123 <break> BGB …") still
  // match; page attribution via the citation's start offset.
  const cleaned = stripRepeatedEdges(pages).map(cleanText)
  const pageStarts: number[] = []
  let text = ''
  for (const p of cleaned) {
    pageStarts.push(text.length)
    text += p + ' '
  }
  const pageOf = (index: number): number => {
    let lo = 0
    let hi = pageStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (pageStarts[mid]! <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  {
    for (const chain of findCitations(text)) {
      const after = text.slice(chain.index + chain.raw.length)
      const rnContext = RN_AFTER_RE.test(after)

      for (const rc of chain.citations) {
        // Junk guard: § numbers beyond any German code.
        if (rc.ref.kind === '§' && parseInt(rc.ref.number, 10) > MAX_SECTION) continue

        const modifiers: Modifier[] = [...rc.modifiers]
        let lawCode: string | undefined
        let implicit = false

        let candidate = rc.codeCandidate

        // "§ 242 Rn. 5" — grammar may capture "Rn" as code candidate.
        if (candidate && /^(?:Rn|Rdnr|Rz|Rnr)\.?$/i.test(candidate.split(' ')[0]!)) {
          candidate = undefined
          if (!modifiers.includes('Rn-context')) modifiers.push('Rn-context')
        }

        // Stray Roman numerals (headings, unconsumed Absatz digits) are
        // never law codes: "… § 142 BGB … I. Einführung".
        if (candidate && /^[IVX]+(?:\s\d+)?$/.test(candidate)) {
          candidate = undefined
        }
        if (rnContext && !modifiers.includes('Rn-context')) modifiers.push('Rn-context')

        if (candidate) {
          let verdict = opts.checkCode(candidate)

          // Footnote-marker digits can glue onto codes ("BGB1" after NFKC).
          // Retry without the trailing digit run — but not for families that
          // legitimately end in digits (SGB V handled as two tokens; G 10; EU refs).
          if (verdict === 'unknown' && /\d$/.test(candidate) && !/[\s/]/.test(candidate)) {
            const stripped = candidate.replace(/\d+$/, '')
            if (stripped.length >= 2 && opts.checkCode(stripped) === 'known') {
              candidate = stripped
              verdict = 'known'
            }
          }

          if (isRejectedCode(candidate) || verdict === 'reject') {
            candidate = undefined
          } else if (verdict === 'known') {
            lawCode = candidate
          } else {
            // Unknown candidate: a plain capitalized German word is prose,
            // not a code ("… § 3 Absatz 1 Der Vertrag …").
            if (/^[A-ZÄÖÜ][a-zäöüß]+$/.test(candidate)) {
              candidate = undefined
            } else {
              lawCode = candidate
              unresolved.set(candidate, (unresolved.get(candidate) ?? 0) + 1)
            }
          }
        }

        if (!lawCode && opts.implicitCode) {
          lawCode = opts.implicitCode
          implicit = true
        }

        if (opts.dropRnContext && modifiers.includes('Rn-context')) continue

        citations.push({
          raw: rc.raw,
          page: pageOf(rc.index),
          ref: rc.ref,
          lawCode,
          implicit,
          modifiers,
          chainId: rc.chainId,
        })
      }
    }
  }

  for (const [code, n] of unresolved) {
    warnings.push({
      message: `Unbekanntes Kürzel „${code}“ (${n}×) – wird ohne Prüfung übernommen.`,
    })
  }

  return { citations, warnings, unresolvedCodes: unresolved }
}
