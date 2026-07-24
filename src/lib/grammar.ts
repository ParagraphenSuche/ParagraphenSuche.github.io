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
  /**
   * Ref #2+ of an enumeration after a SINGULAR sign ("§ 133, 157 BGB").
   * Only trusted when the leg's code validates — otherwise the number may
   * be prose ("nach § 823, 1000 Euro Schaden") and is dropped.
   */
  enumExtra?: boolean
}

// --- building blocks (source strings, composed below) ---

// Section/article number: 823, 306a, 44b. Hard 4-digit cap — a 5-digit run
// (page/header junk) must not match via its prefix. "ff" is never a letter
// suffix (no such norms) — it belongs to the ff.-matcher ("§§535ff.").
// Older typography spaces the suffix ("§§ 448, 475 g, 650 HGB"): a spaced
// single letter counts only when clearly list/code-bound (followed by a
// separator or an uppercase/§ token) — never 'f' (that's "f." = folgende)
// and never before a dot ("i.V.m.", "s.", "a.F." stay words).
const NUM_SUF_SPACED = String.raw`\s[a-eg-z](?=\s*[,;)]|\s+[A-ZÄÖÜ§])`
const NUM = String.raw`\d{1,4}(?!\d)(?:(?!ff(?![a-z]))[a-z]{1,2}|${NUM_SUF_SPACED})?`

// Roman numeral for Absatz shorthand, longest-first, I..XX is realistic.
const ROMAN =
  'XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I'

const IVM = String.raw`(?:i\.?\s?V\.?\s?m\.?|iVm\.?|in\s+Verb(?:indung|\.)\s+mit)`

// One subdivision element with its value. Longest alternatives first.
// Values may be small conjunctions: "Abs. 1 und 2", "Nr. 1, 2 und 5".
// Continuation numbers must not steal the next enumeration item: in
// "§§ 823 Abs. 1, 826 Abs. 2" the "826" belongs to a new ref. The guard is
// level-aware — a continuation followed by a DEEPER detail keyword stays in
// the list ("Abs. 1, 2 und 3 S. 3" keeps the 3), while the same-or-higher
// level ("…, 826 Abs. 2") or Roman shorthand ("…, 311b I") starts a new ref.
const ROMAN_GUARD = String.raw`(?:${ROMAN})(?![A-Za-zÄÖÜäöüß.])`
const KW_ABS = String.raw`Abs(?:ätze|atz|\.)?`
const KW_S = String.raw`S\.|S(?:ätze|atz)`
const KW_HS = String.raw`Halbs(?:atz|\.)?|Hs\.?`
const KW_NR = String.raw`Nrn?\.?|Nummern?`
const KW_ALT = String.raw`Alt(?:ernativen?|\.)?`
const KW_VAR = String.raw`Var(?:ianten?|\.)?`
// Continuation values are capped at 2 digits: detail values (Abs./S./Nr.)
// are practically never >= 100, while a 3-digit continuation is almost
// always the next § of an enumeration ("Nr. 1, 439 BGB" / "S. 1, 670 BGB").
const numlist = (blocked: string[], firstMax = 2): string =>
  String.raw`\d{1,${firstMax}}[a-z]?(?:\s*(?:,|und|oder|bis|bzw\.?|[–—-])\s*\d{1,2}[a-z]?(?![a-z\d])(?!\s*(?:${[...blocked, ROMAN_GUARD].join('|')})))*`
const NL_ABS = numlist([KW_ABS])
const NL_S = numlist([KW_ABS, KW_S])
const NL_HS = numlist([KW_ABS, KW_S, KW_HS])
const NL_NR = numlist([KW_ABS, KW_S, KW_HS, KW_NR], 3)
const NL_ALT = numlist([KW_ABS, KW_S, KW_HS, KW_NR, KW_ALT, KW_VAR])
const LETLIST = String.raw`[a-z]{1,2}\)?(?:\s*(?:,|und|oder|bis)\s*[a-z]{1,2}\)?)*`
const DETAIL = String.raw`(?:\d{1,2}\.\s?(?:Alt(?:ernative)?|Var(?:iante)?|Halbs(?:atz)?|Hs)\.?|U(?:nter)?[Aa]bs(?:atz|\.)?\s*${NL_S}|Abs(?:ätze|atz|\.)?\s*${NL_ABS}|S\.?(?=\s?\d)\s?${NL_S}|S(?:ätze|atz)\s*${NL_S}|Halbs(?:atz|\.)?\s*${NL_HS}|HS\.?(?=\s?\d)\s?${NL_HS}|Hs\.?\s*${NL_HS}|Nrn?\.?\s*${NL_NR}|Nummern?\s*${NL_NR}|Alt(?:ernativen?|\.)?\s*${NL_ALT}|Var(?:ianten?|\.)?\s*${NL_ALT}|Doppelbuchst(?:abe|\.)?\s*[a-z]{2}|Buchst(?:aben?|\.)?\s*${LETLIST}|lit\.?\s*${LETLIST})`

// Roman-numeral shorthand: "823 I 1" = Abs. 1 S. 1. The Roman numeral must
// not be followed by a letter ("§ 1 VVG" must leave VVG to the code).
// Lists are allowed: "Art. 4 I, II GG", "§ 823 I und II BGB".
const ROMAN_ITEM = String.raw`(?:${ROMAN})(?![A-Za-zÄÖÜäöüß.])(?:\s*\d{1,2}(?![.\d]))?`
const ROMAN_SHORT = String.raw`${ROMAN_ITEM}(?:\s?(?:,|und|oder|bis|[–—-])\s?${ROMAN_ITEM})*`

// Short parenthetical insertions inside citations are skipped:
// "§ 311b I 2 (!) BGB", "§ 812 I 1 (a.M.: S. 2), 1. Alt BGB".
// Must not contain a §/Art. sign — "(§ 433 BGB)" is its own citation.
const PAREN = String.raw`\((?![^)]*(?:§|Art\.|Artikel))[^()]{1,40}\)`

// One norm reference: number, optional range, optional f./ff., optional
// details — explicit tokens and Roman shorthand may mix, optionally
// comma-joined ("§ 119 I, 1. Alt. BGB").
const REF = String.raw`${NUM}(?:\s?(?:[–—-]|bis)\s?${NUM})?(?:\s?(?:ff\.?|f\.)(?![a-z]))?(?:\s?(?:,\s?)?(?:${DETAIL}|${ROMAN_SHORT}|${PAREN}))*`

// Enumeration of refs after a plural sign: "823, 826" / "823 Abs. 1, 826
// Abs. 2" / "121 bzw. 124".
const REFLIST = String.raw`${REF}(?:\s?(?:,|und|oder|bzw\.?)\s?${REF})*`

const MODS = String.raw`(?:\s?(?:a\.\s?F\.|n\.\s?F\.|(?:analog|entsprechend)(?![a-zäöüß])))*`

// Trailing law-code candidate. Permissive; validated by the registry later.
// Either an EU instrument pattern or an abbreviation-like token, optionally
// with a second token for families like "SGB V", "G 10".
const CODE_EU = String.raw`(?:VO|Verordnung|RL|Richtlinie)\s?\((?:EU|EG|EWG)\)\s?(?:Nr\.\s?)?\d{1,4}\/\d{2,4}|RL\s?\d{4}\/\d{1,4}\/(?:EU|EG|EWG)`
// Two-token codes: a Roman second token only for the SGB family ("SGB V") —
// a generic Roman option would glue following outline headings on ("… BGB
// V. Abschnitt"). A digit second token only for 1-2 letter bases ("G 10"),
// otherwise stray page numbers attach ("… § 122 BGB 28 Lerneinheit …").
const CODE_TOKEN = String.raw`(?:SGB\s(?:${ROMAN})(?![A-Za-zÄÖÜäöüß.])|R[Oo][Mm]\sI{1,3}(?![A-Za-zÄÖÜäöüß.])|G\s\d{1,2}(?![.\d])|[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9.\/-]{0,29})`
const CODE = String.raw`(?:${CODE_EU}|${CODE_TOKEN})`

// One citation leg: sign + refs + optional inner § (EGBGB: "Art. 246a § 1
// Abs. 2") + modifiers + optional code + optional modifiers.
const SIGN = String.raw`§§|§|Artt\.|Art\.|Artikel`
const CITATION = String.raw`(?:${SIGN})\s?${REFLIST}(?:\s?§\s?${REF})?${MODS}(?:\s?${CODE})?${MODS}`

// Chain connectors: iVm variants (which may be followed by a SIGN-LESS leg:
// "§§ 204 Abs. 1 Nr. 3 BGB i. V. m. 693 Abs. 2 ZPO"), and plain conjunctions
// when followed by a new sign ("§ 823 Abs. 1, § 826 BGB").
const LEG_NOSIGN = String.raw`${REFLIST}${MODS}(?:\s?${CODE})?${MODS}`
const IVM_C = String.raw`\s?${IVM}\s?`
const CONJ_C = String.raw`\s?(?:,|;|und|oder|sowie|bzw\.?)\s?(?=§|Artt?\.|Artikel)`
const CONNECT = String.raw`(?:${IVM_C}|${CONJ_C})`
const CHAIN = String.raw`(?:${CITATION})(?:${IVM_C}(?:${CITATION}|${LEG_NOSIGN})|${CONJ_C}(?:${CITATION}))*`

export const CHAIN_RE = new RegExp(CHAIN, 'gu')

// --- structured re-parsers used inside a matched chain span ---

const SIGN_RE = new RegExp(String.raw`(${SIGN})\s?`, 'yu')
const CONNECT_SPLIT_RE = new RegExp(CONNECT, 'gu')
const IVM_TEST_RE = new RegExp(IVM, 'u')
const NUM_RE = new RegExp(
  String.raw`(\d{1,4})(?!\d)((?:(?!ff(?![a-z]))[a-z]{1,2})?)(?:\s([a-eg-z])(?=\s*[,;)]|\s+[A-ZÄÖÜ§]))?`,
  'yu',
)
const RANGE_RE = new RegExp(String.raw`\s?([–—-]|bis)\s?(${NUM})`, 'yu')
const FF_RE = new RegExp(String.raw`\s?(ff\.?|f\.)(?![a-z])`, 'yu')
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
const PAREN_RE = new RegExp(String.raw`\s?${PAREN}`, 'yu')
const MOD_RE = new RegExp(
  String.raw`\s?(a\.\s?F\.|n\.\s?F\.|(?:analog|entsprechend)(?![a-zäöüß]))`,
  'yu',
)
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

  if (/^U(?:nter)?[Aa]bs/.test(t))
    return { level: 'UAbs.', value: tail(/^U(?:nter)?[Aa]bs(?:atz|\.)?\s*/) }
  if (/^Abs/.test(t)) return { level: 'Abs.', value: tail(/^Abs(?:ätze|atz|\.)?\s*/) }
  if (/^S(?:\.|\s?\d|ätze|atz)/.test(t))
    return { level: 'S.', value: tail(/^S(?:ätze|atz|\.)?\s*/) }
  if (/^(?:Halbs|HS|Hs)/.test(t))
    return { level: 'Hs.', value: tail(/^(?:Halbs(?:atz|\.)?|HS\.?|Hs\.?)\s*/) }
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

    // Skip short parentheticals: "§ 311b I 2 (!) BGB".
    const pm = eat(PAREN_RE, leg, pos)
    if (pm) {
      pos = pm.index + pm[0].length
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

  let prevKind: Kind | undefined
  const legGloss: boolean[] = [] // per citation: leg ends in a parenthetical
  for (const leg of legs) {
    const cits = parseLeg(leg.text, offset + leg.at, prevKind)
    if (cits.length > 0) prevKind = cits[cits.length - 1]!.ref.kind
    const gloss = /\)\s*$/.test(leg.text)
    for (const c of cits) {
      legGloss.push(gloss)
      citations.push(c)
    }
  }

  // Backward code propagation: "§ 812 iVm § 818 BGB" → both BGB.
  // The LAST citation's written code applies to earlier code-less ones —
  // but never across a leg that ends in a parenthetical gloss: in
  // "§ 718 (Gesellschaft), § 1416 (Gütergemeinschaft), § 105 II HGB" the
  // glossed norms belong to another (implied) law; they stay code-less
  // and go to the ambiguous table instead of inheriting the wrong code.
  const lastCode = citations.length ? citations[citations.length - 1]!.codeCandidate : undefined
  if (lastCode) {
    for (let i = citations.length - 1; i >= 0; i--) {
      if (legGloss[i]) break
      if (!citations[i]!.codeCandidate) citations[i]!.codeCandidate = lastCode
    }
  }
  if (chainId) for (const c of citations) c.chainId = chainId

  return { raw: span, index: offset, citations }
}

/**
 * Parse one leg: sign + ref(s) + mods + code. A sign-less leg after iVm
 * ("… i. V. m. 693 Abs. 2 ZPO") inherits the previous leg's kind.
 */
function parseLeg(leg: string, offset: number, inheritKind?: Kind): RawCitation[] {
  const sm = eat(SIGN_RE, leg, 0)
  let kind: Kind
  let plural: boolean
  let pos: number
  if (sm) {
    const sign = sm[1]!
    kind = sign.startsWith('§') ? '§' : 'Art.'
    plural = sign === '§§' || sign === 'Artt.'
    pos = sm.index + sm[0].length
  } else if (inheritKind && /^\s?\d/.test(leg)) {
    kind = inheritKind
    plural = false
    pos = leg.startsWith(' ') ? 1 : 0
  } else {
    return []
  }

  const refs: NormRef[] = []

  for (;;) {
    const nm = eat(NUM_RE, leg, pos)
    if (!nm) break
    pos = nm.index + nm[0].length
    const ref: NormRef = { kind, number: nm[1]! + (nm[2] ?? '') + (nm[3] ?? ''), details: [] }

    const rm = eat(RANGE_RE, leg, pos)
    if (rm) {
      ref.numberEnd = rm[2]!.replace(/\s/g, '')
      pos = rm.index + rm[0].length
    }
    const fm = eat(FF_RE, leg, pos)
    if (fm) {
      ref.ff = fm[1]!.startsWith('ff') ? 'ff.' : 'f.'
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

    // Further refs: standard after a plural sign ("§§ 823, 826"); sloppy
    // singular enumerations ("§ 133, 157 BGB") are parsed too but marked
    // enumExtra so the extractor can drop them when no code validates.
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
    // Trailing sentence punctuation, split-compound hyphens ("Miet- und
    // Pachtrecht") and stray slashes are not part of the code.
    codeCandidate = cm[1]!.replace(/\s+/g, ' ').trim().replace(/[.,;:/–-]+$/, '')
    pos = cm.index + cm[0].length
  }
  eatMods()

  return refs.map((ref, i) => ({
    raw: leg.trim(),
    index: offset,
    ref,
    codeCandidate,
    modifiers: [...modifiers],
    enumExtra: !plural && i > 0 ? true : undefined,
  }))
}
