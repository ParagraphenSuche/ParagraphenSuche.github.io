/**
 * Law-code registry: validates written code candidates and resolves them to
 * gesetze-im-internet slugs (federal law) or EU instruments.
 */
import { normalizeCodeKey, isRejectedCode, type CodeVerdict } from './extractor'
import aliasData from '../data/aliases.json'
import euData from '../data/eu_laws.json'

export interface ResolvedLaw {
  /** Display code, e.g. "BGB", "DSGVO". */
  display: string
  /** gesetze-im-internet slug when this is federal law. */
  slug?: string
  /** True for EU/international instruments (no staleness check in v1). */
  eu?: boolean
}

interface EuLaw {
  code: string
  name: string
  aliases: string[]
}

export class LawRegistry {
  private bySlugKey = new Map<string, string>() // normalized key -> slug
  private slugs: string[] = []
  private euByKey = new Map<string, EuLaw>()
  private aliasToSlug = new Map<string, string | null>()

  constructor(slugs: string[]) {
    this.slugs = slugs
    for (const slug of slugs) {
      // gii slugs replace umlauts with "_" (BörsG -> b_rsg_2007) and append
      // year suffixes. Index the raw base too, so an umlaut-transliterated
      // candidate key can hit it.
      const base = slug.replace(/_\d{1,4}$/, '')
      this.bySlugKey.set(normalizeCodeKey(slug.replace(/_/g, '')), slug)
      this.bySlugKey.set(normalizeCodeKey(base.replace(/_/g, '')), slug)
      if (base.includes('_')) this.bySlugKey.set(base, slug)
    }
    // Explicit aliases override automatic slug matching.
    for (const [key, slug] of Object.entries(aliasData.slugAliases as Record<string, string | null>)) {
      this.aliasToSlug.set(normalizeCodeKey(key), slug)
    }
    for (const law of (euData as { laws: EuLaw[] }).laws) {
      this.euByKey.set(normalizeCodeKey(law.code), law)
      for (const a of law.aliases) this.euByKey.set(normalizeCodeKey(a), law)
    }
  }

  resolve(code: string): ResolvedLaw | null {
    const key = normalizeCodeKey(code)
    if (!key || isRejectedCode(code)) return null

    const alias = this.aliasToSlug.get(key)
    if (alias !== undefined) {
      return alias === null ? null : { display: code, slug: alias }
    }

    const eu = this.euByKey.get(key)
    if (eu) return { display: eu.code, eu: true }

    // Generic EU instrument patterns (VO (EU) 2019/1150 …) not in our list.
    if (/^(vo|verordnung|rl|richtlinie)\(?(eu|eg|ewg)\)?(nr)?\d+\/\d+$/.test(key)) {
      return { display: code, eu: true }
    }

    const direct = this.bySlugKey.get(key)
    if (direct) return { display: code, slug: direct }

    // Umlaut transliteration: gii writes BörsG as b_rsg_2007, AÜG as a_g.
    const umlautKey = code.toLowerCase().replace(/[\s.\-–]/g, '').replace(/[äöü]/g, '_')
    if (umlautKey !== key) {
      const viaUmlaut = this.bySlugKey.get(umlautKey)
      if (viaUmlaut) return { display: code, slug: viaUmlaut }
    }

    // Year-suffixed slugs: "bdsg" -> newest of bdsg_2018, bdsg_1990 …
    for (const probe of umlautKey !== key ? [key, umlautKey] : [key]) {
      const prefixed = this.slugs
        .filter((s) => s.startsWith(`${probe}_`))
        .sort()
        .reverse()
      if (prefixed.length > 0) return { display: code, slug: prefixed[0]! }
    }

    // Unknown -VO/-RL suffix: treat as an (unchecked) EU instrument —
    // "Offenlegungs-VO", "Warenkauf-RL", "BilanzRL" …
    if (/(?:vo|rl)$/.test(key) && key.length > 3) {
      return { display: code, eu: true }
    }

    return null
  }

  check = (code: string): CodeVerdict => {
    if (isRejectedCode(code)) return 'reject'
    return this.resolve(code) ? 'known' : 'unknown'
  }
}

/** Minimal offline fallback so extraction still validates common codes. */
export const FALLBACK_CODES = [
  'BGB', 'StGB', 'ZPO', 'StPO', 'GG', 'HGB', 'AktG', 'GmbHG', 'InsO', 'EStG', 'AO',
  'VwGO', 'VwVfG', 'SGB', 'UWG', 'UrhG', 'MarkenG', 'PatG', 'BImSchG', 'KrWG', 'WHG',
  'EGBGB', 'FamFG', 'GVG', 'ArbGG', 'KSchG', 'TVG', 'BetrVG', 'WEG', 'ErbbauRG',
  'StVG', 'StVO', 'StVZO', 'PflVG', 'ProdHaftG', 'VVG', 'TKG', 'BDSG', 'IfSG', 'OWiG',
]

export function fallbackRegistry(): LawRegistry {
  return new LawRegistry(FALLBACK_CODES.map((c) => c.toLowerCase()))
}
