/**
 * Pipeline orchestration: cleaned pages -> validated Citations.
 * Code validation is injected (the real registry arrives with the
 * staleness feature; tests and the offline path use a static set).
 */
import type { AnalysisWarning, Citation, Modifier } from './models'
import { cleanText, dropBareNumberLines, dropDuplicatedLayer, dropRunningHeader, fixShiftedEncoding, stripRepeatedEdges } from './textclean'
import { splitBodyAndFootnotes } from './pdftext'
import { findCitations } from './grammar'
import aliasData from '../data/aliases.json'
import kommData from '../data/kommentare.json'

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
  /** The joined body+footnote text that offsets (charIndex) refer to. */
  joinedText: string
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
const HEADING_AFTER_RE = /^\s[A-ZÄÖÜ][a-zäöüß]{2,}/

/**
 * Author context directly before a citation marks a literature reference:
 * "Brox/Walker, " (slash-joined names) or "Stadler, BGB AT, " (name plus a
 * short work segment). Commentary citations are unaffected — they carry
 * their own law code ("Grüneberg, § 281 BGB, Rn. 20").
 */
const AUTHOR_PREFIX_RE =
  /(?:[A-ZÄÖÜ][a-zäöüß]+(?:\/[A-ZÄÖÜ][a-zäöüß]+)+,?\s+(?:[A-Z0-9][A-Za-z0-9.\-]*\s?){0,4},?\s*|[A-ZÄÖÜ][a-zäöüß]+,\s*[A-Za-zÄÖÜäöüß.\- ]{1,28},\s*)(?:vor\s|Einf\.\s*v\.\s*)?$/

// A trailing PAGE reference (", S. 116") marks literature — statutes have
// no Seiten. Only meaningful for code-less citations.
const PAGEREF_AFTER_RE = /^\s?,\s?S\.\s?\d/

// Edition markers right before a citation ("K. Schmidt Handelsrecht,
// 5. Aufl. 1999, § 26 II 1") are literature context.
const AUFL_BEFORE_RE = /\d{1,2}\.\s?Aufl\.?\s?\d{0,4},?\s*$/

/**
 * Single-law commentary brands: "Staudinger/Gursky § 985 Rn. 10" numbers a
 * BGB norm even without a written code — commentaries are organized by the
 * statute they comment on. Multi-law series carry the code in the work
 * token (MüKoBGB, BeckOK ZPO) and resolve via that suffix.
 */
const KOMM = kommData as {
  brands: Record<string, string>
  pairs: Record<string, string>
  seriesPrefixes: string[]
}
const KOMM_WORK_RE = /([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]+)\/([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+)[^§]{0,30}$/

function commentaryLaw(before: string): string | undefined {
  const m = KOMM_WORK_RE.exec(before)
  if (!m) return undefined
  const first = m[1]!.toLowerCase().replace(/-/g, '')
  const pairKey = `${first}/${m[2]!.toLowerCase().replace(/[.-]/g, '')}`
  if (KOMM.pairs[pairKey]) return KOMM.pairs[pairKey]
  if (KOMM.brands[first]) return KOMM.brands[first]
  // Series with embedded code: MüKoBGB/Wagner, BeckOK ZPO/…, jurisPK-BGB/…
  for (const prefix of KOMM.seriesPrefixes) {
    if (first.startsWith(prefix)) {
      const suffix = first.slice(prefix.length).toUpperCase()
      if (/^(BGB|HGB|ZPO|STPO|STGB|INSO|AKTG|GMBHG|GG|VWGO|VWVFG|OWIG)$/.test(suffix)) {
        return suffix === 'STGB' ? 'StGB' : suffix === 'STPO' ? 'StPO'
          : suffix === 'INSO' ? 'InsO' : suffix === 'AKTG' ? 'AktG'
          : suffix === 'GMBHG' ? 'GmbHG' : suffix === 'VWGO' ? 'VwGO'
          : suffix === 'VWVFG' ? 'VwVfG' : suffix === 'OWIG' ? 'OWiG' : suffix
      }
    }
  }
  return undefined
}

export function extractFromPages(pages: string[], opts: ExtractOptions): ExtractResult {
  const citations: Citation[] = []
  const warnings: AnalysisWarning[] = []
  const unresolved = new Map<string, number>()

  // Separate body text from footnote blocks, strip repeated headers/
  // footers, then join ALL page bodies first and all footnote blocks after.
  // Body sentences interrupted by footnotes rejoin across page breaks
  // ("… aus § 823 <Fußnoten|Seitenwechsel> BGB, sofern …"); page
  // attribution works via segment start offsets for both streams.
  const split = pages.map(fixShiftedEncoding).map(dropDuplicatedLayer).map(splitBodyAndFootnotes)
  const bodies = stripRepeatedEdges(
    split.map((x) => dropBareNumberLines(dropRunningHeader(x.body))),
  ).map(cleanText)
  const smalls = split.map((x) => cleanText(x.small))

  const segStarts: Array<{ start: number; page: number }> = []
  let text = ''
  for (let i = 0; i < bodies.length; i++) {
    segStarts.push({ start: text.length, page: i + 1 })
    text += bodies[i]! + ' '
  }
  // Sentence guard so the last body cannot chain into the first footnote.
  text += '.\n'
  for (let i = 0; i < smalls.length; i++) {
    if (!smalls[i]) continue
    segStarts.push({ start: text.length, page: i + 1 })
    text += smalls[i]! + ' '
  }
  const pageOf = (index: number): number => {
    let lo = 0
    let hi = segStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segStarts[mid]!.start <= index) lo = mid
      else hi = mid - 1
    }
    return segStarts[lo]!.page
  }

  {
    for (const chain of findCitations(text)) {
      const after = text.slice(chain.index + chain.raw.length)
      const rnContext = RN_AFTER_RE.test(after)
      const before = text.slice(Math.max(0, chain.index - 60), chain.index)
      const authorContext = AUTHOR_PREFIX_RE.test(before)
      // TOC/heading entries ("§ 1 Das Handelsrecht"): a bare single-§ chain
      // immediately followed by a capitalized prose word numbers a chapter.
      const headingContext =
        chain.citations.length === 1 && HEADING_AFTER_RE.test(after)
      const pageRefContext = PAGEREF_AFTER_RE.test(after)
      const auflContext = AUFL_BEFORE_RE.test(before)

      for (const rc of chain.citations) {
        // Junk guard: § numbers beyond any German code.
        if (rc.ref.kind === '§' && parseInt(rc.ref.number, 10) > MAX_SECTION) continue

        const modifiers: Modifier[] = [...rc.modifiers]
        let lawCode: string | undefined
        let implicit = false

        let candidate = rc.codeCandidate

        // "§ 242 Rn. 5" — grammar may capture "Rn" as code candidate.
        if (candidate && /^(?:Rn|Rdnr|Rz|Rnr)\.?\d*$/i.test(candidate.split(' ')[0]!)) {
          candidate = undefined
          if (!modifiers.includes('Rn-context')) modifiers.push('Rn-context')
        }

        // Stray Roman numerals (headings, unconsumed Absatz digits) and
        // single-letter outline labels ("§ 985 D.") are never law codes.
        if (candidate && (/^[IVX]+(?:\s\d+)?$/.test(candidate) || /^[A-ZÄÖÜ]$/.test(candidate))) {
          candidate = undefined
        }
        if (rnContext && !modifiers.includes('Rn-context')) modifiers.push('Rn-context')

        if (candidate) {
          let verdict = opts.checkCode(candidate)

          // Footnote-marker digits can glue onto codes ("BGB1" after NFKC).
          // Retry without the trailing digit run — but not for families that
          // legitimately end in digits (SGB V handled as two tokens; G 10; EU refs).
          if (verdict === 'unknown' && /\d$/.test(candidate) && !/[\s/]/.test(candidate)) {
            const stripped = candidate.replace(/\d+$/, '').replace(/[.,;:]+$/, '')
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
            // not a code ("… § 3 Absatz 1 Der Vertrag …") — unless it looks
            // like a written-out law name ("Arzneimittelgesetz").
            if (
              /^[A-ZÄÖÜ][a-zäöüß]+$/.test(candidate) &&
              !/(?:gesetz|gesetzbuch|verordnung|ordnung)$/i.test(candidate)
            ) {
              candidate = undefined
            } else {
              lawCode = candidate
              unresolved.set(candidate, (unresolved.get(candidate) ?? 0) + 1)
            }
          }
        }

        // Singular-sign enumeration extras ("§ 133, 157 BGB") are only
        // real citations when the leg's code validated — otherwise the
        // trailing number is likely prose ("nach § 823, 1000 Euro …").
        if (rc.enumExtra && !lawCode) continue

        // Known single-law commentary before the citation: the § IS a norm
        // of that commentary's law (inferred, shown as implicit).
        if (!lawCode) {
          const kommLaw = commentaryLaw(before)
          if (kommLaw) {
            lawCode = kommLaw
            implicit = true
          }
        }

        // Code-less citation in a literature context: the § numbers a
        // chapter of the cited work, not a statute. Never give it the
        // implicit code — the chapter/implicit degeneracy is resolved by
        // the fact that commentary cites carry their own code.
        const bare =
          rc.ref.kind === '§' &&
          rc.ref.details.length === 0 &&
          !rc.ref.numberEnd &&
          !rc.ref.ff
        const verweis =
          !lawCode &&
          (modifiers.includes('Rn-context') ||
            authorContext ||
            pageRefContext ||
            auflContext ||
            (headingContext && bare))

        if (!verweis && !lawCode && opts.implicitCode) {
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
          charIndex: rc.index,
          verweis: verweis || undefined,
        })
      }
    }
  }

  for (const [code, n] of unresolved) {
    warnings.push({
      message: `Unbekanntes Kürzel „${code}“ (${n}×) – wird ohne Prüfung übernommen.`,
    })
  }

  return { citations, warnings, unresolvedCodes: unresolved, joinedText: text }
}
