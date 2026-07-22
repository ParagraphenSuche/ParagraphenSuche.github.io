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
import { normLabel, RANGE_VERIFY_LIMIT, rowSpanWidth } from './report'
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
    if (row.law === '[Verweis]') {
      row.staleness = {
        status: 'UNKNOWN',
        note: 'Verweis auf Literatur oder Kapitel – keine Norm.',
      }
      continue
    }
    const resolved = registry.resolve(row.law)

    if (!resolved) {
      row.staleness = {
        status: 'UNKNOWN',
        note: row.law === '[?]' ? 'Kein Gesetzeskürzel erkannt.' : `Unbekanntes Kürzel „${row.law}“.`,
      }
      continue
    }
    if (resolved.historic) {
      const rep = resolved.historic.repealed
      const repYear = parseInt(rep.slice(0, 4), 10)
      const [ry, rm, rd] = rep.split('-')
      const repDate = rd ? `${parseInt(rd, 10)}.${parseInt(rm!, 10)}.${ry}` : rep
      row.staleness =
        repYear > year
          ? {
              status: 'PARA_CHANGED',
              note: `${resolved.display} wurde zum ${repDate} aufgehoben – heute: ${resolved.historic.successor}.`,
            }
          : {
              status: 'UNKNOWN',
              note: `${resolved.display} war bereits seit ${repDate} außer Kraft (heute: ${resolved.historic.successor}).`,
            }
      continue
    }
    if (resolved.workKind) {
      row.staleness = {
        status: 'UNKNOWN',
        note: `Kein Bundesgesetz – ${resolved.workKind} (keine Änderungsprüfung möglich).`,
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

    // Wide range citations ("§§ 433–853" = hundreds of norms): individual
    // verification is disabled; warn so the user checks the relevant norms.
    const rangeWidth = rowSpanWidth(row)
    if (rangeWidth > RANGE_VERIFY_LIMIT) {
      row.staleness = {
        status: 'LAW_CHANGED',
        lawLastAmended: amended,
        note: `${lawNote} Bereichszitat über ca. ${rangeWidth} Normen – Einzelprüfung deaktiviert, bitte relevante Normen selbst prüfen.`,
      }
      continue
    }

    if (law.snapshotXml && law.snapshotXml !== 'unavailable') {
      // Numbers to verify: the single norm, every integer in a narrow
      // range, or start + successor for "f.". For open-ended "ff." only
      // the start norm is verifiable.
      const start = parseInt(row.number, 10)
      const numbers: string[] = row.numberEnd
        ? Array.from({ length: rangeWidth }, (_, i) => String(start + i))
        : row.ff === 'f.'
          ? [row.number, String(start + 1)]
          : [row.number]

      const changed: string[] = []
      const unknown: string[] = []
      for (const num of numbers) {
        const then = extractNormText(law.snapshotXml, row.kind, num)
        const now = extractNormText(law.currentXml, row.kind, num)
        if (then && now) {
          if (then !== now) changed.push(num)
        } else if (!then && !now) {
          unknown.push(num)
        } else {
          changed.push(num) // inserted or repealed since the document year
        }
      }

      const ffCaveat =
        row.ff === 'ff.'
          ? ' Umfang des ff.-Zitats unbestimmt – Folgenormen bitte selbst prüfen.'
          : ''

      if (changed.length > 0) {
        const which =
          numbers.length > 1
            ? ` (geändert: ${changed.map((n) => `${row.kind} ${n}`).join(', ')})`
            : ''
        row.staleness = {
          status: 'PARA_CHANGED',
          lawLastAmended: amended,
          note: `${normLabel(row)} ${row.law} wurde seit ${year} geändert!${which}${ffCaveat}`,
        }
        continue
      }
      if (unknown.length < numbers.length) {
        const caveat =
          unknown.length > 0
            ? ` (${unknown.map((n) => `${row.kind} ${n}`).join(', ')} nicht auffindbar.)`
            : ''
        row.staleness = {
          status: row.ff === 'ff.' ? 'LAW_CHANGED' : 'PARA_UNCHANGED',
          lawLastAmended: amended,
          note:
            row.ff === 'ff.'
              ? `${lawNote} Startnorm ${row.kind} ${row.number} ist textgleich zum Stand ${year}.${ffCaveat}`
              : `${lawNote} ${normLabel(row)} selbst ist textgleich zum Stand ${year}.${caveat}`,
        }
        continue
      }
      // no verifiable norm — fall through to per-law verdict
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
