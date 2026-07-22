import { describe, expect, it } from 'vitest'
import {
  applyStaleness,
  extractNormText,
  lastAmended,
  parseStandDates,
  type Sources,
} from '../src/lib/staleness'
import { LawRegistry } from '../src/lib/registry'
import type { TableRow } from '../src/lib/models'

function lawXml(opts: { stand: string[]; norms: Record<string, string> }): string {
  const kommentare = opts.stand
    .map((s) => `<standangabe><standtyp>Stand</standtyp><standkommentar>${s}</standkommentar></standangabe>`)
    .join('')
  const norms = Object.entries(opts.norms)
    .map(
      ([enbez, text]) =>
        `<norm builddate="x" doknr="y"><metadaten><jurabk>TG</jurabk><enbez>${enbez}</enbez></metadaten><textdaten><text format="XML"><Content><P>${text}</P></Content></text></textdaten></norm>`,
    )
    .join('')
  return `<?xml version="1.0"?><dokumente><norm doknr="head"><metadaten><jurabk>TG</jurabk>${kommentare}</metadaten></norm>${norms}</dokumente>`
}

const CURRENT = lawXml({
  stand: [
    'Neugefasst durch Bek. v. 2.1.2002 I 42',
    'zuletzt geändert durch Art. 2 Abs. 1 G v. 12.5.2026 I Nr. 143',
  ],
  norms: { '§ 1': 'Neuer Text von Paragraph eins.', '§ 2': 'Unveränderter Text.', '§ 3': 'Ganz neu.' },
})

const SNAPSHOT_2015 = lawXml({
  stand: ['Neugefasst durch Bek. v. 2.1.2002 I 42'],
  norms: { '§ 1': 'Alter Text von Paragraph eins.', '§ 2': 'Unveränderter Text.', '§ 4': 'Später aufgehoben.' },
})

describe('parseStandDates / lastAmended', () => {
  it('extracts and sorts all dates', () => {
    expect(parseStandDates(CURRENT)).toEqual(['2002-01-02', '2026-05-12'])
    expect(lastAmended(CURRENT)).toBe('2026-05-12')
  })
  it('handles the "textlich nachgewiesen" wording', () => {
    const xml = lawXml({
      stand: ['Änderung durch Art. 2 G v. 2.7.2026 I Nr. 198 textlich nachgewiesen, dokumentarisch noch nicht abschließend bearbeitet'],
      norms: {},
    })
    expect(lastAmended(xml)).toBe('2026-07-02')
  })
})

describe('extractNormText', () => {
  it('finds § by number and strips markup', () => {
    expect(extractNormText(CURRENT, '§', '2')).toBe('Unveränderter Text.')
  })
  it('does not confuse § 1 with § 10', () => {
    const xml = lawXml({ stand: [], norms: { '§ 10': 'zehn', '§ 1': 'eins' } })
    expect(extractNormText(xml, '§', '1')).toBe('eins')
  })
  it('handles Art variants', () => {
    const xml = lawXml({ stand: [], norms: { 'Art 3': 'drei' } })
    expect(extractNormText(xml, 'Art.', '3')).toBe('drei')
  })
  it('returns null for missing norm', () => {
    expect(extractNormText(CURRENT, '§', '99')).toBeNull()
  })
  it('EGBGB-style Artikel via gliederungsbez', () => {
    const xml = `<dokumente><norm><metadaten><gliederungseinheit><gliederungsbez>Art 246a</gliederungsbez></gliederungseinheit></metadaten></norm><norm><metadaten><enbez>§ 1</enbez></metadaten><textdaten><text><Content><P>Informationspflichten Text.</P></Content></text></textdaten></norm><norm><metadaten><gliederungseinheit><gliederungsbez>Art 246b</gliederungsbez></gliederungseinheit></metadaten></norm></dokumente>`
    expect(extractNormText(xml, 'Art.', '246a')).toContain('Informationspflichten Text.')
    expect(extractNormText(xml, 'Art.', '246a')).not.toContain('246b')
  })
})

function mkRow(number: string, law = 'TG', numberEnd?: string): TableRow {
  return {
    law,
    kind: '§',
    number,
    numberEnd,
    variants: [],
    pages: [1],
    impliedPages: [],
    implicitOnly: false,
    modifiers: [],
    pageSources: {},
  }
}

const registry = new LawRegistry(['tg'])

const okSources: Sources = {
  fetchCurrentLawXml: async () => CURRENT,
  findSnapshotSha: async () => 'abc123',
  fetchLawXmlAtRef: async () => SNAPSHOT_2015,
}

describe('applyStaleness', () => {
  it('full per-§ verdicts', async () => {
    const rows = [mkRow('1'), mkRow('2'), mkRow('3'), mkRow('4'), mkRow('99')]
    await applyStaleness(rows, registry, 2015, undefined, okSources)
    expect(rows[0]!.staleness?.status).toBe('PARA_CHANGED') // text differs
    expect(rows[1]!.staleness?.status).toBe('PARA_UNCHANGED') // identical
    expect(rows[2]!.staleness?.status).toBe('PARA_CHANGED') // newly inserted
    expect(rows[3]!.staleness?.status).toBe('PARA_CHANGED') // repealed
    expect(rows[4]!.staleness?.status).toBe('LAW_CHANGED') // in neither version
  })

  it('UNCHANGED when law not amended after year', async () => {
    const rows = [mkRow('1')]
    await applyStaleness(rows, registry, 2026, undefined, okSources)
    expect(rows[0]!.staleness?.status).toBe('POSSIBLY_STALE') // amended within 2026
    const rows2 = [mkRow('1')]
    await applyStaleness(rows2, registry, 2027, undefined, okSources)
    expect(rows2[0]!.staleness?.status).toBe('UNCHANGED')
  })

  it('per-law fallback when archive too shallow', async () => {
    const rows = [mkRow('1')]
    await applyStaleness(rows, registry, 2015, undefined, {
      ...okSources,
      findSnapshotSha: async () => null,
    })
    expect(rows[0]!.staleness?.status).toBe('LAW_CHANGED')
  })

  it('EU and unresolved codes are UNKNOWN', async () => {
    const rows = [mkRow('6', 'DSGVO'), mkRow('5', 'XYZG'), mkRow('7', '[?]')]
    await applyStaleness(rows, registry, 2015, undefined, okSources)
    expect(rows.map((r) => r.staleness?.status)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
  })

  it('wide ranges skip per-§ verification with a warning', async () => {
    const rows = [mkRow('1', 'TG', '100')]
    await applyStaleness(rows, registry, 2015, undefined, okSources)
    expect(rows[0]!.staleness?.status).toBe('LAW_CHANGED')
    expect(rows[0]!.staleness?.note).toContain('Bereichszitat')
    expect(rows[0]!.staleness?.note).toContain('selbst prüfen')
  })

  it('narrow ranges verify every norm and name the changed ones', async () => {
    const rows = [mkRow('1', 'TG', '2')] // § 1 changed, § 2 unchanged
    await applyStaleness(rows, registry, 2015, undefined, okSources)
    expect(rows[0]!.staleness?.status).toBe('PARA_CHANGED')
    expect(rows[0]!.staleness?.note).toContain('§ 1')
  })

  it('narrow range with only unchanged norms is PARA_UNCHANGED', async () => {
    const sources: Sources = {
      ...okSources,
      fetchLawXmlAtRef: async () =>
        lawXml({ stand: [], norms: { '§ 2': 'Unveränderter Text.' } }),
    }
    const rows = [mkRow('2', 'TG', '2')] // degenerate range width 1
    await applyStaleness(rows, registry, 2015, undefined, sources)
    expect(rows[0]!.staleness?.status).toBe('PARA_UNCHANGED')
  })

  it('fetches each law only once', async () => {
    let fetches = 0
    const rows = [mkRow('1'), mkRow('2'), mkRow('3')]
    await applyStaleness(rows, registry, 2015, undefined, {
      ...okSources,
      fetchCurrentLawXml: async () => (fetches++, CURRENT),
    })
    expect(fetches).toBe(1)
  })
})
