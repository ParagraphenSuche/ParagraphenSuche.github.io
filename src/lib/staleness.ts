/**
 * Staleness check: has a cited norm changed since the document year?
 *
 * Per-law level: max amendment date from the law XML's <standkommentar>.
 * Per-§ level: compare the norm's text between the mirror snapshot closest
 * to the document year and today's version. Degrades gracefully to per-law
 * (rate limit, shallow archive) and to UNKNOWN (EU law, unresolved codes).
 */
import type { StalenessResult, TableRow } from './models'
import type { LawRegistry } from './registry'
import * as realSources from './sources'
import { RateLimitError } from './sources'

export interface Sources {
  fetchCurrentLawXml(slug: string): Promise<string>
  findSnapshotSha(slug: string, untilIso: string): Promise<string | null>
  fetchLawXmlAtRef(slug: string, ref: string): Promise<string>
}

/** All amendment dates mentioned in the law's standkommentar entries (ISO). */
export function parseStandDates(xml: string): string[] {
  const head = xml.slice(0, 20000) // stand data lives in the first norm
  const dates: string[] = []
  for (const km of head.matchAll(/<standkommentar>([^<]*)<\/standkommentar>/g)) {
    for (const d of km[1]!.matchAll(/v\.?\s*(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/g)) {
      dates.push(`${d[3]}-${d[2]!.padStart(2, '0')}-${d[1]!.padStart(2, '0')}`)
    }
  }
  return dates.sort()
}

export function lastAmended(xml: string): string | null {
  const dates = parseStandDates(xml)
  return dates.length ? dates[dates.length - 1]! : null
}

/**
 * Normalized text of the norm with the given enbez number, or null.
 * enbez forms: "§ 823", "§ 306a", "Art 3", "Art. 3".
 */
export function extractNormText(xml: string, kind: '§' | 'Art.', number: string): string | null {
  const enbezPattern =
    kind === '§'
      ? String.raw`§\s*${escapeRe(number)}`
      : String.raw`Art(?:ikel|\.)?\s*${escapeRe(number)}`
  const re = new RegExp(
    String.raw`<norm[^>]*>(?:(?!</norm>).)*?<enbez>\s*${enbezPattern}\s*</enbez>((?:(?!</norm>).)*)</norm>`,
    's',
  )
  const m = re.exec(xml)
  if (m) {
    const text = m[1]!.match(/<textdaten>(.*)<\/textdaten>/s)?.[1] ?? m[1]!
    return stripXml(text)
  }

  // EGBGB-style laws store Artikel as section headers (<gliederungsbez>
  // "Art 246a") whose actual norms carry §-enbez. Compare the whole
  // section: everything up to the next gliederungsbez.
  if (kind === 'Art.') {
    const gre = new RegExp(
      String.raw`<gliederungsbez>\s*Art(?:ikel|\.)?\s*${escapeRe(number)}\s*</gliederungsbez>(.*?)(?=<gliederungsbez>|$)`,
      's',
    )
    const gm = gre.exec(xml)
    if (gm) return stripXml(gm[1]!)
  }
  return null
}

function stripXml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${parseInt(d!, 10)}.${parseInt(m!, 10)}.${y}`
}

interface LawState {
  currentXml: string | null
  lastAmended: string | null
  snapshotXml: string | null | 'unavailable'
}

/**
 * Annotates rows in place with StalenessResults.
 * Fetches each law once; per-§ compare only when the law changed after the year.
 */
export async function applyStaleness(
  rows: TableRow[],
  registry: LawRegistry,
  year: number,
  onProgress?: (msg: string) => void,
  sources: Sources = realSources,
): Promise<void> {
  const yearEnd = `${year}-12-31`
  const laws = new Map<string, LawState>()
  let rateLimited = false

  for (const row of rows) {
    const resolved = registry.resolve(row.law)

    if (!resolved) {
      row.staleness = {
        status: 'UNKNOWN',
        note: row.law === '[?]' ? 'Kein Gesetzeskürzel erkannt.' : `Unbekanntes Kürzel „${row.law}“.`,
      }
      continue
    }
    if (resolved.eu || !resolved.slug) {
      row.staleness = { status: 'UNKNOWN', note: 'EU-/internationales Recht wird noch nicht geprüft.' }
      continue
    }

    const slug = resolved.slug
    let law = laws.get(slug)
    if (!law) {
      law = { currentXml: null, lastAmended: null, snapshotXml: null }
      laws.set(slug, law)
      try {
        onProgress?.(`Prüfe ${row.law} …`)
        law.currentXml = await sources.fetchCurrentLawXml(slug)
        law.lastAmended = lastAmended(law.currentXml)
      } catch (e) {
        if (e instanceof RateLimitError) rateLimited = true
        law.currentXml = null
      }
    }

    if (!law.currentXml) {
      row.staleness = {
        status: 'UNKNOWN',
        note: rateLimited
          ? 'Prüfung nicht möglich (GitHub-Abruflimit erreicht – später erneut versuchen).'
          : 'Gesetzestext konnte nicht geladen werden.',
      }
      continue
    }

    const amended = law.lastAmended
    if (!amended || amended <= yearEnd) {
      row.staleness = {
        status: amended && amended >= `${year}-01-01` ? 'POSSIBLY_STALE' : 'UNCHANGED',
        lawLastAmended: amended ?? undefined,
        note: amended
          ? amended >= `${year}-01-01`
            ? `${row.law} wurde noch ${fmtDate(amended)} geändert – im Erscheinungsjahr selbst.`
            : `${row.law} seit ${fmtDate(amended)} unverändert.`
          : `Keine Änderungsdaten für ${row.law} gefunden.`,
      }
      continue
    }

    // Law amended after the document year — try to pin down the specific §.
    if (law.snapshotXml === null && !rateLimited) {
      try {
        onProgress?.(`Lade ${row.law} (Stand ${year}) …`)
        const sha = await sources.findSnapshotSha(slug, yearEnd)
        law.snapshotXml = sha ? await sources.fetchLawXmlAtRef(slug, sha) : 'unavailable'
      } catch (e) {
        if (e instanceof RateLimitError) rateLimited = true
        law.snapshotXml = 'unavailable'
      }
    }

    const lawNote = `${row.law} zuletzt geändert ${fmtDate(amended)}.`
    if (law.snapshotXml && law.snapshotXml !== 'unavailable') {
      const then = extractNormText(law.snapshotXml, row.kind, row.number)
      const now = extractNormText(law.currentXml, row.kind, row.number)
      if (then && now) {
        row.staleness =
          then === now
            ? {
                status: 'PARA_UNCHANGED',
                lawLastAmended: amended,
                note: `${lawNote} ${row.kind} ${row.number} selbst ist textgleich zum Stand ${year}.`,
              }
            : {
                status: 'PARA_CHANGED',
                lawLastAmended: amended,
                note: `${row.kind} ${row.number} ${row.law} wurde seit ${year} geändert!`,
              }
        continue
      }
      if (!then && now) {
        row.staleness = {
          status: 'PARA_CHANGED',
          lawLastAmended: amended,
          note: `${row.kind} ${row.number} ${row.law} wurde nach ${year} neu eingefügt.`,
        }
        continue
      }
      if (then && !now) {
        row.staleness = {
          status: 'PARA_CHANGED',
          lawLastAmended: amended,
          note: `${row.kind} ${row.number} ${row.law} existiert in der aktuellen Fassung nicht mehr (aufgehoben?).`,
        }
        continue
      }
      // in neither version — fall through to per-law verdict
    }

    row.staleness = {
      status: 'LAW_CHANGED',
      lawLastAmended: amended,
      note:
        law.snapshotXml === 'unavailable'
          ? rateLimited
            ? `${lawNote} (Abruflimit erreicht – Norm-Vergleich später erneut versuchen.)`
            : lawNote
          : `${lawNote} (${row.kind} ${row.number} dort nicht auffindbar – nur Gesetzesebene geprüft.)`,
    }
  }
}
