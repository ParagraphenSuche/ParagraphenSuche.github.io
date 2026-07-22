/**
 * Citation grammar for German statute references.
 *
 * Two-phase approach: a coarse scanner regex finds candidate chain spans
 * ("§ 812 Abs. 1 S. 1 Alt. 2 iVm § 818 Abs. 2 BGB"), then a structured
 * parser walks each span and produces one RawCitation per norm.
 * Law-code validation happens later (extractor + registry) — the grammar
 * only captures a permissive trailing code candidate.
 */
import type { Detail, Kind, Modifier, NormRef } from './models'
import { romanToArabic } from './models'

/** Parsed but not yet code-validated citation. */
export interface RawCitation {
  raw: string
  index: number // char offset within page text
  ref: NormRef
  /** Trailing code candidate as written, not yet validated. */
  codeCandidate?: string
  modifiers: Modifier[]
  chainId?: number
}

// --- building blocks (source strings, composed below) ---

// Section/article number: 823, 306a, 44b. Hard 4-digit cap — a 5-digit run
// (page/header junk) must not match via its prefix.
const NUM = String.raw`\d{1,4}(?!\d)[a-z]{0,2}`

// Roman numeral for Absatz shorthand, longest-first, I..XX is realistic.
const ROMAN =
  'XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I'

const IVM = String.raw`(?:i\.?\s?V\.?\s?m\.?|iVm\.?|in\s+Verb(?:indung|\.)\s+mit)`

// One subdivision element with its value. Longest alternatives first.
// Values may be small conjunctions: "Abs. 1 und 2", "Nr. 1, 2 und 5".
// Continuation numbers must not steal the next enumeration item:
// in "§§ 823 Abs. 1, 826 Abs. 2" the "826" belongs to a new ref, so a
// continuation number followed by its own detail keyword is not consumed.
const DETAIL_KEYWORD = String.raw`(?:Abs|S(?:atz|ätze|\.)|Halbs|Hs|Nrn?|Nummern?|Alt|Var|Doppelbuchst|Buchst|lit)`
const NUMLIST = String.raw`\d{1,3}[a-z]?(?:\s*(?:,|und|oder|bis|[–—-])\s*\d{1,3}[a-z]?(?!\d)(?!\s*${DETAIL_KEYWORD}))*`
const LETLIST = String.raw`[a-z]{1,2}\)?(?:\s*(?:,|und|oder|bis)\s*[a-z]{1,2}\)?)*`
const DETAIL = String.raw`(?:\d{1,2}\.\s?(?:Alt(?:ernative)?|Var(?:iante)?|Halbs(?:atz)?|Hs)\.?|Abs(?:ätze|atz|\.)?\s*${NUMLIST}|S\.\s*${NUMLIST}|S(?:ätze|atz)\s*${NUMLIST}|Halbs(?:atz|\.)?\s*${NUMLIST}|Hs\.?\s*${NUMLIST}|Nrn?\.?\s*${NUMLIST}|Nummern?\s*${NUMLIST}|Alt(?:ernativen?|\.)?\s*${NUMLIST}|Var(?:ianten?|\.)?\s*${NUMLIST}|Doppelbuchst(?:abe|\.)?\s*[a-z]{2}|Buchst(?:aben?|\.)?\s*${LETLIST}|lit\.?\s*${LETLIST})`

// Roman-numeral shorthand: "823 I 1" = Abs. 1 S. 1. The Roman numeral must
// not be followed by a letter ("§ 1 VVG" must leave VVG to the code).
// Lists are allowed: "Art. 4 I, II GG", "§ 823 I und II BGB".
const ROMAN_ITEM = String.raw`(?:${ROMAN})(?![A-Za-zÄÖÜäöüß.])(?:\s*\d{1,2}(?![.\d]))?`
const ROMAN_SHORT = String.raw`${ROMAN_ITEM}(?:\s?(?:,|und|oder|bis|[–—-])\s?${ROMAN_ITEM})*`

// One norm reference: number, optional range, optional f./ff., optional
// details — explicit tokens and Roman shorthand may mix, optionally
// comma-joined ("§ 119 I, 1. Alt. BGB").
const REF = String.raw`${NUM}(?:\s?(?:[–—-]|bis)\s?${NUM})?(?:\s?ff?\.)?(?:\s?(?:,\s?)?(?:${DETAIL}|${ROMAN_SHORT}))*`

// Enumeration of refs after a plural sign: "823, 826" / "823 Abs. 1, 826
// Abs. 2" / "121 bzw. 124".
const REFLIST = String.raw`${REF}(?:\s?(?:,|und|oder|bzw\.?)\s?${REF})*`

const MODS = String.raw`(?:\s?(?:a\.\s?F\.|n\.\s?F\.|analog|entsprechend))*`

// Trailing law-code candidate. Permissive; validated by the registry later.
// Either an EU instrument pattern or an abbreviation-like token, optionally
// with a second token for families like "SGB V", "G 10".
const CODE_EU = String.raw`(?:VO|Verordnung|RL|Richtlinie)\s?\((?:EU|EG|EWG)\)\s?(?:Nr\.\s?)?\d{1,4}\/\d{2,4}|RL\s?\d{4}\/\d{1,4}\/(?:EU|EG|EWG)`
// Two-token codes: a Roman second token for families like "SGB V"; a digit
// second token only for 1-2 letter bases ("G 10") — otherwise stray page
// numbers glue on ("… § 122 BGB 28 Lerneinheit …" in a TOC). Neither may
// attach across a sentence boundary ("… BGB. 4. Trennungsprinzip").
const CODE_TOKEN = String.raw`(?:[A-ZÄÖÜ]{1,2}\s\d{1,2}(?![.\d])|[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9.\/-]{0,29}(?:(?<!\.)\s(?:${ROMAN})(?![A-Za-zÄÖÜäöüß.]))?)`
const CODE = String.raw`(?:${CODE_EU}|${CODE_TOKEN})`

// One citation leg: sign + refs + optional inner § (EGBGB: "Art. 246a § 1
// Abs. 2") + modifiers + optional code + optional modifiers.
const SIGN = String.raw`§§|§|Artt\.|Art\.|Artikel`
const CITATION = String.raw`(?:${SIGN})\s?${REFLIST}(?:\s?§\s?${REF})?${MODS}(?:\s?${CODE})?${MODS}`

// Chain connectors: iVm variants, and plain conjunctions when followed by a
// new sign ("§ 823 Abs. 1, § 826 BGB" — the trailing code covers both legs).
const CONNECT = String.raw`\s?(?:${IVM}|,|;|und|oder|sowie|bzw\.?)\s?(?=§|Artt?\.|Artikel)`
const CHAIN = String.raw`(?:${CITATION})(?:${CONNECT}(?:${CITATION}))*`

export const CHAIN_RE = new RegExp(CHAIN, 'gu')

// --- structured re-parsers used inside a matched chain span ---

const SIGN_RE = new RegExp(String.raw`(${SIGN})\s?`, 'yu')
const CONNECT_SPLIT_RE = new RegExp(CONNECT, 'gu')
const IVM_TEST_RE = new RegExp(IVM, 'u')
const NUM_RE = new RegExp(String.raw`(\d{1,4})(?!\d)([a-z]{0,2})`, 'yu')
const RANGE_RE = new RegExp(String.raw`\s?([–—-]|bis)\s?(${NUM})`, 'yu')
const FF_RE = new RegExp(String.raw`\s?(ff?\.)`, 'yu')
const DETAIL_RE = new RegExp(String.raw`\s?${DETAIL}`, 'yu')
const ROMAN_ITEM_RE = new RegExp(
  String.raw`\s?(${ROMAN})(?![A-Za-zÄÖÜäöüß.])(?:\s*(\d{1,2})(?![.\d]))?`,
  'yu',
)
const ROMAN_SEP_RE = new RegExp(
  String.raw`\s?(,|und|oder|bis|[–—-])\s?(?=(?:${ROMAN})(?![A-Za-zÄÖÜäöüß.]))`,
  'yu',
)
const INNER_PARA_RE = new RegExp(String.raw`\s?§\s?(\d{1,4})(?!\d)([a-z]{0,2})`, 'yu')
const SEP_RE = new RegExp(String.raw`\s?(,|und|oder|bzw\.?)\s?`, 'yu')
const COMMA_RE = new RegExp(String.raw`\s?,\s?`, 'yu')
const MOD_RE = new RegExp(String.raw`\s?(a\.\s?F\.|n\.\s?F\.|analog|entsprechend)`, 'yu')
const CODE_RE = new RegExp(String.raw`\s?(${CODE})`, 'yu')

/** Normalize a matched detail token to a Detail object. */
function parseDetailToken(token: string): Detail {
  const t = token.trim()

  // Ordinal-prefixed form: "1. Alt.", "2. Var", "1. Hs."
  const ord = /^(\d{1,2})\.\s?(Alt|Var|Halbs|Hs)/.exec(t)
  if (ord) {
    const level = ord[2] === 'Alt' ? 'Alt.' : ord[2] === 'Var' ? 'Var.' : 'Hs.'
    return { level, value: ord[1]! }
  }
  const norm = (value: string): string =>
    value
      .replace(/\s*(?:[–—]|bis)\s*/g, '-')
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s*(und|oder)\s*/g, ' $1 ')
      .trim()
  const tail = (re: RegExp): string => norm(t.replace(re, ''))

  if (/^Abs/.test(t)) return { level: 'Abs.', value: tail(/^Abs(?:ätze|atz|\.)?\s*/) }
  if (/^S/.test(t)) return { level: 'S.', value: tail(/^S(?:ätze|atz|\.)?\s*/) }
  if (/^(?:Halbs|Hs)/.test(t)) return { level: 'Hs.', value: tail(/^(?:Halbs(?:atz|\.)?|Hs\.?)\s*/) }
  if (/^N(?:r|ummer)/.test(t)) return { level: 'Nr.', value: tail(/^(?:Nrn?\.?|Nummern?)\s*/) }
  if (/^Alt/.test(t)) return { level: 'Alt.', value: tail(/^Alt(?:ernativen?|\.)?\s*/) }
  if (/^Var/.test(t)) return { level: 'Var.', value: tail(/^Var(?:ianten?|\.)?\s*/) }
  if (/^Doppelbuchst/.test(t))
    return { level: 'Doppelbuchst.', value: tail(/^Doppelbuchst(?:abe|\.)?\s*/) }
  if (/^(?:Buchst|lit)/.test(t))
    return { level: 'lit.', value: tail(/^(?:Buchst(?:aben?|\.)?|lit\.?)\s*/).replace(/\)/g, '') }
  return { level: 'Abs.', value: norm(t) } // unreachable fallback
}

/** Try to match `re` (sticky) at `pos` in `s`; advances and returns match or null. */
function eat(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(s)
}

/**
 * Consume detail tokens and/or Roman shorthand into ref.details.
 * Mixed, optionally comma-joined sequences occur in the wild:
 * "I 1", "I, II", "I, 1. Alt.", "Abs. 1 S. 2".
 */
function eatDetails(leg: string, pos: number, ref: NormRef): number {
  let abs: Detail | null = null
  for (;;) {
    // Optional comma before a further detail ("§ 119 I, 1. Alt. BGB") —
    // only consumed when an actual detail follows.
    let p = pos
    const cm = eat(COMMA_RE, leg, p)
    if (cm) p = cm.index + cm[0].length

    const dm = eat(DETAIL_RE, leg, p)
    if (dm) {
      ref.details.push(parseDetailToken(dm[0]))
      pos = dm.index + dm[0].length
      abs = null
      continue
    }

    const rsm = eat(ROMAN_ITEM_RE, leg, p)
    if (rsm) {
      pos = rsm.index + rsm[0].length
      const value = String(romanToArabic(rsm[1]!))
      if (!abs) {
        abs = { level: 'Abs.', value }
        ref.details.push(abs)
        if (rsm[2]) ref.details.push({ level: 'S.', value: rsm[2] })
      } else {
        abs.value += `, ${value}`
      }
      // Roman lists with non-comma joiners: "I und II", "II bis IV".
      const sep = eat(ROMAN_SEP_RE, leg, pos)
      if (sep) pos = sep.index + sep[0].length
      continue
    }
    break
  }
  return pos
}

export interface ChainMatch {
  raw: string
  index: number
  citations: RawCitation[]
}

let chainCounter = 0

/**
 * Find and parse all citation chains in a cleaned page text.
 */
export function findCitations(text: string): ChainMatch[] {
  const out: ChainMatch[] = []
  CHAIN_RE.lastIndex = 0
  for (let m = CHAIN_RE.exec(text); m !== null; m = CHAIN_RE.exec(text)) {
    const parsed = parseChainSpan(m[0], m.index)
    if (parsed.citations.length > 0) out.push(parsed)
  }
  return out
}

/** Parse one chain span into RawCitations (one per norm). */
export function parseChainSpan(span: string, offset: number): ChainMatch {
  const chainId = IVM_TEST_RE.test(span) ? ++chainCounter : undefined
  const citations: RawCitation[] = []

  // Split on connectors (iVm, ", §", "und Art." …) while keeping leg offsets.
  const legs: Array<{ text: string; at: number }> = []
  CONNECT_SPLIT_RE.lastIndex = 0
  let last = 0
  for (let m = CONNECT_SPLIT_RE.exec(span); m !== null; m = CONNECT_SPLIT_RE.exec(span)) {
    legs.push({ text: span.slice(last, m.index), at: last })
    last = m.index + m[0].length
  }
  legs.push({ text: span.slice(last), at: last })

  for (const leg of legs) {
    citations.push(...parseLeg(leg.text, offset + leg.at))
  }

  // Backward code propagation: "§ 812 iVm § 818 BGB" → both BGB.
  // The LAST citation's written code applies to earlier code-less ones.
  const lastCode = citations.length ? citations[citations.length - 1]!.codeCandidate : undefined
  if (lastCode) {
    for (const c of citations) if (!c.codeCandidate) c.codeCandidate = lastCode
  }
  if (chainId) for (const c of citations) c.chainId = chainId

  return { raw: span, index: offset, citations }
}

/** Parse one leg: sign + ref(s) + mods + code. */
function parseLeg(leg: string, offset: number): RawCitation[] {
  const sm = eat(SIGN_RE, leg, 0)
  if (!sm) return []
  const sign = sm[1]!
  const kind: Kind = sign.startsWith('§') ? '§' : 'Art.'
  const plural = sign === '§§' || sign === 'Artt.'
  let pos = sm.index + sm[0].length

  const refs: NormRef[] = []

  for (;;) {
    const nm = eat(NUM_RE, leg, pos)
    if (!nm) break
    pos = nm.index + nm[0].length
    const ref: NormRef = { kind, number: nm[1]! + nm[2]!, details: [] }

    const rm = eat(RANGE_RE, leg, pos)
    if (rm) {
      ref.numberEnd = rm[2]!
      pos = rm.index + rm[0].length
    }
    const fm = eat(FF_RE, leg, pos)
    if (fm) {
      ref.ff = fm[1] as 'f.' | 'ff.'
      pos = fm.index + fm[0].length
    }

    // Details: explicit tokens or Roman shorthand (single or list).
    pos = eatDetails(leg, pos, ref)

    // EGBGB pattern: an Artikel containing §§ — "Art. 246a § 1 Abs. 2 S. 2".
    if (kind === 'Art.') {
      const im = eat(INNER_PARA_RE, leg, pos)
      if (im) {
        pos = im.index + im[0].length
        ref.details.push({ level: '§', value: im[1]! + im[2]! })
        pos = eatDetails(leg, pos, ref)
      }
    }

    refs.push(ref)

    // Further refs only after a plural sign ("§§ 823, 826").
    if (!plural) break
    const sep = eat(SEP_RE, leg, pos)
    if (!sep) break
    pos = sep.index + sep[0].length
  }

  if (refs.length === 0) return []

  // Modifiers (may appear before and/or after the code).
  const modifiers: Modifier[] = []
  const eatMods = () => {
    for (;;) {
      const mm = eat(MOD_RE, leg, pos)
      if (!mm) break
      modifiers.push(mm[1]!.replace(/\s/g, '') as Modifier)
      pos = mm.index + mm[0].length
    }
  }
  eatMods()

  let codeCandidate: string | undefined
  const cm = eat(CODE_RE, leg, pos)
  if (cm) {
    // Trailing sentence punctuation is not part of the code ("… BGB. Auch …").
    codeCandidate = cm[1]!.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '')
    pos = cm.index + cm[0].length
  }
  eatMods()

  return refs.map((ref) => ({
    raw: leg.trim(),
    index: offset,
    ref,
    codeCandidate,
    modifiers: [...modifiers],
  }))
}
