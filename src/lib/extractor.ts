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
 * Back-matter register pages (Gesetzesverzeichnis, Sachregister, Paragraphen-
 * register): dense §-reference lists with almost no prose. Their §§ are index
 * entries — extracting them floods the ambiguous table with book-chapter
 * references and duplicates every law under [?]. Detection is structural
 * (register headings often don't survive the text layer): a page counts as a
 * register page when most lines consist of citation-ish tokens and running
 * prose is nearly absent. Only applied to the trailing quarter of documents
 * of realistic book length (registers are back matter).
 */
const REGISTER_MIN_PAGES = 40
const REGISTER_TAIL_FRACTION = 0.75
const REGISTER_TOKEN_RE =
  /^(?:§§?|Artt?\.?|\d{1,4}[a-z]{0,2}[.,;:]?|[IVXLivxl]{1,6}[.,;:]?|[a-zß]{1,2}[.,;:]?|ff?\s?\.[,;]?|Fn\.?|pr\.?[,;]?|Rn\.?|Nrn?\.?|Abs\.?|S\.?|Hs\.?|a\.E\.[,;]?|[,;.:()–—-]+|\.{2,}|[A-ZÄÖÜ][A-Za-z0-9ÄÖÜäöüß./§-]{0,29}:?)$/

export function isRegisterPage(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 12) return false
  const refs = (text.match(/§/g) ?? []).length
  if (refs < 8) return false
  let refish = 0
  let prose = 0
  for (const line of lines) {
    // Six consecutive multi-letter lowercase words = a running sentence.
    if (/(?:\p{Ll}{3,}\s+){5}\p{Ll}{3,}/u.test(line)) {
      prose++
      continue
    }
    const tokens = line.split(/\s+/)
    const good = tokens.filter((t) => REGISTER_TOKEN_RE.test(t)).length
    if (good / tokens.length >= 0.7) refish++
  }
  return refish / lines.length >= 0.6 && prose / lines.length <= 0.15
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
  // Register detection needs line structure, so it runs pre-cleanText.
  const rawBodies = stripRepeatedEdges(
    split.map((x) => dropBareNumberLines(dropRunningHeader(x.body))),
  )
  const bodies = rawBodies.map(cleanText)
  const smalls = split.map((x) => cleanText(x.small))

  // Drop back-matter register pages (Gesetzesverzeichnis/Sachregister).
  const registerPages: number[] = []
  if (pages.length >= REGISTER_MIN_PAGES) {
    for (let i = Math.floor(pages.length * REGISTER_TAIL_FRACTION); i < bodies.length; i++) {
      if (isRegisterPage(rawBodies[i]!)) {
        registerPages.push(i + 1)
        bodies[i] = ''
        smalls[i] = ''
      }
    }
  }
  if (registerPages.length > 0) {
    const first = registerPages[0]!
    const last = registerPages[registerPages.length - 1]!
    warnings.push({
      message:
        `Verzeichnis-Seiten erkannt und ignoriert (Gesetzes-/Sachregister): ` +
        (registerPages.length > 2 ? `${registerPages.length} Seiten im Bereich ${first}–${last}.` : `Seite ${registerPages.join(', ')}.`),
    })
  }

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

        // Code-less citation in a literature context: the § numbers a
        // chapter of the cited work, not a statute. Never give it the
        // implicit code. Commentary citations without a written code
        // (Staudinger/Gursky § 985) also stay code-less here — whether
        // they denote a norm of the commented statute is decided by the
        // AI classification, not deterministically.
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
