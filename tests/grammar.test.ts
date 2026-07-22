import { describe, expect, it } from 'vitest'
import { extractFromPages, type CodeVerdict } from '../src/lib/extractor'
import { canonical } from '../src/lib/models'

const KNOWN = new Set(
  [
    'BGB', 'StGB', 'ZPO', 'StPO', 'GG', 'HGB', 'VVG', 'GmbHG', 'AktG', 'EStG', 'InsO',
    'VwGO', 'VwVfG', 'UWG', 'UrhG', 'MarkenG', 'BImSchG', 'SGB V', 'SGB II', 'G 10',
    'DSGVO', 'AEUV', 'EUV', 'GRCh', 'EMRK', 'WEG', 'StVG', 'ProdHaftG', 'BDSG',
  ].map((c) => c.toLowerCase().replace(/[\s.\-]/g, '')),
)

const checkCode = (code: string): CodeVerdict =>
  KNOWN.has(code.toLowerCase().replace(/[\s.\-]/g, '')) ? 'known' : 'unknown'

/** Run extraction on a single text snippet, return canonical citation strings. */
function run(text: string, implicitCode?: string): string[] {
  const { citations } = extractFromPages([text], { checkCode, implicitCode })
  return citations.map((c) => canonical(c))
}

describe('basic § citations', () => {
  it('simple', () => expect(run('Nach § 823 BGB haftet, wer …')).toEqual(['§ 823 BGB']))
  it('no space after §', () => expect(run('gemäß §823 BGB')).toEqual(['§ 823 BGB']))
  it('letter suffix', () => expect(run('vgl. § 306a BGB')).toEqual(['§ 306a BGB']))
  it('full detail chain', () =>
    expect(run('Der Anspruch aus § 812 Abs. 1 S. 1 Alt. 1 BGB setzt voraus')).toEqual([
      '§ 812 Abs. 1 S. 1 Alt. 1 BGB',
    ]))
  it('Absatz written out', () =>
    expect(run('§ 823 Absatz 1 Satz 1 BGB')).toEqual(['§ 823 Abs. 1 S. 1 BGB']))
  it('Nr. and lit.', () =>
    expect(run('§ 3 Abs. 1 Nr. 2 lit. b UWG')).toEqual(['§ 3 Abs. 1 Nr. 2 lit. b UWG']))
  it('Hs.', () => expect(run('§ 281 Abs. 1 S. 1 Hs. 2 BGB')).toEqual(['§ 281 Abs. 1 S. 1 Hs. 2 BGB']))
  it('Var.', () => expect(run('§ 823 Abs. 1 Var. 3 BGB')).toEqual(['§ 823 Abs. 1 Var. 3 BGB']))
})

describe('Roman-numeral shorthand', () => {
  it('Abs as Roman', () => expect(run('aus § 823 I BGB folgt')).toEqual(['§ 823 Abs. 1 BGB']))
  it('Abs + Satz', () => expect(run('nach § 823 I 1 BGB')).toEqual(['§ 823 Abs. 1 S. 1 BGB']))
  it('higher Roman', () => expect(run('Art. 14 III GG')).toEqual(['Art. 14 Abs. 3 GG']))
  it('tight spacing', () => expect(run('vgl. §823I1BGB')).toEqual(['§ 823 Abs. 1 S. 1 BGB']))
  it('does not eat single-letter code start', () =>
    expect(run('gemäß § 1 VVG gilt')).toEqual(['§ 1 VVG']))
  it('normalizes to same key as long form', () => {
    const a = run('§ 823 I 1 BGB')
    const b = run('§ 823 Abs. 1 S. 1 BGB')
    expect(a).toEqual(b)
  })
})

describe('enumerations and ranges', () => {
  it('§§ enumeration', () =>
    expect(run('Ansprüche aus §§ 823, 826 BGB kommen in Betracht')).toEqual([
      '§ 823 BGB',
      '§ 826 BGB',
    ]))
  it('§§ with details', () =>
    expect(run('§§ 823 Abs. 1, 826 Abs. 2 BGB')).toEqual([
      '§ 823 Abs. 1 BGB',
      '§ 826 Abs. 2 BGB',
    ]))
  it('range with dash', () => expect(run('§§ 12–15 GmbHG')).toEqual(['§§ 12–15 GmbHG']))
  it('range with bis', () => expect(run('§§ 1 bis 3 UWG')).toEqual(['§§ 1–3 UWG']))
  it('ff.', () => expect(run('§ 613a ff. BGB')).toEqual(['§ 613a ff. BGB']))
  it('f.', () => expect(run('§ 823 f. BGB')).toEqual(['§ 823 f. BGB']))
  it('und enumeration', () =>
    expect(run('§§ 823 und 826 BGB')).toEqual(['§ 823 BGB', '§ 826 BGB']))
})

describe('Art. citations and EU law', () => {
  it('GG article', () => expect(run('Art. 3 Abs. 1 GG')).toEqual(['Art. 3 Abs. 1 GG']))
  it('Artikel written out', () => expect(run('Artikel 20 GG')).toEqual(['Art. 20 GG']))
  it('DSGVO with lit.', () =>
    expect(run('Art. 6 Abs. 1 lit. f DSGVO')).toEqual(['Art. 6 Abs. 1 lit. f DSGVO']))
  it('AEUV', () => expect(run('nach Art. 101 AEUV verboten')).toEqual(['Art. 101 AEUV']))
  it('EU regulation as code', () =>
    expect(run('Art. 4 VO (EU) Nr. 1215/2012')).toEqual(['Art. 4 VO (EU) Nr. 1215/2012']))
})

describe('iVm chains', () => {
  it('code propagates backwards', () =>
    expect(run('Anspruch aus § 812 iVm § 818 BGB')).toEqual(['§ 812 BGB', '§ 818 BGB']))
  it('i.V.m. variant', () =>
    expect(run('§ 280 Abs. 1 i.V.m. § 241 Abs. 2 BGB')).toEqual([
      '§ 280 Abs. 1 BGB',
      '§ 241 Abs. 2 BGB',
    ]))
  it('in Verbindung mit', () =>
    expect(run('§ 11 in Verbindung mit § 22 StGB')).toEqual(['§ 11 StGB', '§ 22 StGB']))
  it('cross-kind chain keeps own codes', () =>
    expect(run('§ 823 Abs. 1 BGB iVm Art. 2 Abs. 1 GG')).toEqual([
      '§ 823 Abs. 1 BGB',
      'Art. 2 Abs. 1 GG',
    ]))
})

describe('modifiers', () => {
  it('a.F. after code', () => expect(run('§ 306a BGB a.F.')).toEqual(['§ 306a a.F. BGB']))
  it('analog', () => expect(run('§ 823 BGB analog')).toEqual(['§ 823 analog BGB']))
})

describe('multi-token codes', () => {
  it('SGB V', () => expect(run('§ 5 SGB V regelt')).toEqual(['§ 5 SGB V']))
  it('G 10', () => expect(run('§ 3 G 10 erlaubt')).toEqual(['§ 3 G 10']))
})

describe('implicit code', () => {
  it('bare citation gets implicit code', () => {
    const { citations } = extractFromPages(['Nach § 823 Abs. 1 haftet der Schädiger.'], {
      checkCode,
      implicitCode: 'BGB',
    })
    expect(citations).toHaveLength(1)
    expect(citations[0]!.lawCode).toBe('BGB')
    expect(citations[0]!.implicit).toBe(true)
  })
  it('written code wins over implicit', () => {
    const { citations } = extractFromPages(['Nach § 823 Abs. 1 StGB gilt.'], {
      checkCode,
      implicitCode: 'BGB',
    })
    expect(citations[0]!.lawCode).toBe('StGB')
    expect(citations[0]!.implicit).toBe(false)
  })
})

describe('false positives', () => {
  it('journal citation', () => expect(run('BGH NJW 2020, 123 hat entschieden')).toEqual([]))
  it('court reporter', () => expect(run('BVerfGE 89, 214 – Bürgschaft')).toEqual([]))
  it('bare Rn.', () => expect(run('siehe Rn. 5')).toEqual([]))
  it('Art. as word', () => expect(run('die Art. der Verpackung')).toEqual([]))
  it('huge § from header junk', () => expect(run('§ 12345 BGB')).toEqual([]))
  it('NJW not captured as code', () =>
    expect(run('§ 823 NJW 2020, 123')).toEqual(['§ 823'])) // code dropped, § kept
  it('capitalized prose word not captured as code', () =>
    expect(run('Nach § 3 Absatz 1 Der Vertrag ist nichtig')).toEqual(['§ 3 Abs. 1']))
})

describe('Rn. commentary context', () => {
  it('keeps norm, marks Rn-context', () => {
    const { citations } = extractFromPages(['Grüneberg § 242 Rn. 5 führt aus'], { checkCode })
    expect(citations).toHaveLength(1)
    expect(citations[0]!.ref.number).toBe('242')
    expect(citations[0]!.modifiers).toContain('Rn-context')
  })
  it('dropRnContext removes them', () => {
    const { citations } = extractFromPages(['Grüneberg § 242 Rn. 5 führt aus'], {
      checkCode,
      dropRnContext: true,
    })
    expect(citations).toEqual([])
  })
  it('normal citation not affected by option', () => {
    const { citations } = extractFromPages(['§ 242 BGB gilt.'], {
      checkCode,
      dropRnContext: true,
    })
    expect(citations).toHaveLength(1)
  })
})

describe('footnote-digit glue', () => {
  it('BGB1 resolves to BGB', () => expect(run('§ 823 BGB1 und weiter')).toEqual(['§ 823 BGB']))
})

describe('page attribution', () => {
  it('citations land on their page', () => {
    const { citations } = extractFromPages(['§ 1 BGB', 'kein Zitat', '§ 2 BGB'], { checkCode })
    expect(citations.map((c) => [c.ref.number, c.page])).toEqual([
      ['1', 1],
      ['2', 3],
    ])
  })
})
