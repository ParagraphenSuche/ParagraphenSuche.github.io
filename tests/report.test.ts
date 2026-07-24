import { describe, expect, it } from 'vitest'
import { extractFromPages, type CodeVerdict } from '../src/lib/extractor'
import {
  applyAiResults,
  groupCitations,
  splitRows,
  toCsv,
  toMarkdown,
  compareSectionNumber,
  sortRowsByStaleness,
} from '../src/lib/report'

const checkCode = (code: string): CodeVerdict =>
  ['BGB', 'StGB', 'GG'].includes(code) ? 'known' : 'unknown'

describe('groupCitations', () => {
  it('merges variants under one (law, kind, number) key', () => {
    const { citations } = extractFromPages(
      ['§ 823 I 1 BGB und später § 823 Abs. 1 S. 1 BGB sowie § 823 Abs. 2 BGB'],
      { checkCode },
    )
    const rows = groupCitations(citations)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.variants).toEqual(['§ 823 Abs. 1 S. 1 BGB', '§ 823 Abs. 2 BGB'])
  })

  it('sorts by law then numeric section', () => {
    const { citations } = extractFromPages(['§ 90 BGB, dann § 823 BGB, dann § 12 StGB'], {
      checkCode,
    })
    const rows = groupCitations(citations)
    expect(rows.map((r) => `${r.law} ${r.number}`)).toEqual(['BGB 90', 'BGB 823', 'StGB 12'])
  })

  it('deduplicates and sorts pages', () => {
    const { citations } = extractFromPages(['§ 1 BGB', '§ 1 BGB und § 1 BGB', '§ 1 BGB'], {
      checkCode,
    })
    const rows = groupCitations(citations)
    expect(rows[0]!.pages).toEqual([1, 2, 3])
  })

  it('marks implicit-only rows', () => {
    const { citations } = extractFromPages(['Nach § 823 Abs. 1 haftet X. Daneben gilt § 826 BGB.'], {
      checkCode,
      implicitCode: 'BGB',
    })
    const rows = groupCitations(citations)
    const r823 = rows.find((r) => r.number === '823')!
    const r826 = rows.find((r) => r.number === '826')!
    expect(r823.implicitOnly).toBe(true)
    expect(r826.implicitOnly).toBe(false)
  })
})

describe('implied pages from ranges and ff.', () => {
  it('range covers separately cited § inside it', () => {
    const { citations } = extractFromPages(['§ 815 BGB gilt.', '§§ 812–822 BGB regeln das.'], {
      checkCode,
    })
    const rows = groupCitations(citations)
    const r815 = rows.find((r) => r.number === '815')!
    expect(r815.pages).toEqual([1])
    expect(r815.impliedPages).toEqual([2])
  })
  it('f. covers exactly the next §', () => {
    const { citations } = extractFromPages(['§ 823 f. BGB', '§ 824 BGB und § 826 BGB'], {
      checkCode,
    })
    const rows = groupCitations(citations)
    expect(rows.find((r) => r.number === '824')!.impliedPages).toEqual([1])
    expect(rows.find((r) => r.number === '826')!.impliedPages).toEqual([])
  })
  it('ff. covers a bounded window', () => {
    const { citations } = extractFromPages(['§ 104 ff. BGB', '§ 110 BGB', '§ 433 BGB'], {
      checkCode,
    })
    const rows = groupCitations(citations)
    expect(rows.find((r) => r.number === '110')!.impliedPages).toEqual([1])
    expect(rows.find((r) => r.number === '433')!.impliedPages).toEqual([])
  })
  it('explicit page wins over implied on the same page', () => {
    const { citations } = extractFromPages(['§ 815 BGB und §§ 812–822 BGB'], { checkCode })
    const rows = groupCitations(citations)
    const r815 = rows.find((r) => r.number === '815')!
    expect(r815.pages).toEqual([1])
    expect(r815.impliedPages).toEqual([])
  })
})

describe('compareSectionNumber', () => {
  it('numeric-aware ordering', () => {
    expect(['823', '90', '306a', '306', '1004'].sort(compareSectionNumber)).toEqual([
      '90',
      '306',
      '306a',
      '823',
      '1004',
    ])
  })
})

describe('sortRowsByStaleness', () => {
  it('changed first, then ambiguous, then current', () => {
    const { citations } = extractFromPages(['§ 1 BGB, § 2 BGB, § 3 BGB, § 4 BGB, § 5 BGB'], {
      checkCode,
    })
    const rows = groupCitations(citations)
    const set = (n: string, status: string) => {
      const r = rows.find((x) => x.number === n)!
      r.staleness = { status: status as never, note: '' }
    }
    set('1', 'UNCHANGED')
    set('2', 'PARA_CHANGED')
    set('3', 'UNKNOWN')
    set('4', 'LAW_CHANGED')
    set('5', 'PARA_UNCHANGED')
    sortRowsByStaleness(rows)
    expect(rows.map((r) => r.number)).toEqual(['2', '4', '3', '1', '5'])
  })
})

describe('exports', () => {
  it('CSV has BOM, header and semicolons', () => {
    const { citations } = extractFromPages(['§ 823 BGB'], { checkCode })
    const csv = toCsv(groupCitations(citations))
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('Gesetz;Norm;Zitat-Varianten;Seiten;Status;Hinweis')
    expect(csv).toContain('BGB;§ 823;§ 823 BGB;1;;')
  })
  it('Markdown table renders', () => {
    const { citations } = extractFromPages(['§ 823 BGB'], { checkCode })
    const md = toMarkdown(groupCitations(citations), 'Test')
    expect(md).toContain('| BGB | § 823 | § 823 BGB | 1 |')
  })
})

describe('applyAiResults', () => {
  const mkRow = (law: string, number: string, pages: number[]): import('../src/lib/models').TableRow => ({
    law, kind: '§', number, variants: [`§ ${number}`], pages, impliedPages: [],
    implicitOnly: false, modifiers: [], pageSources: {},
  })
  const normalize = (c: string) => c.toLowerCase().replace(/[\s.\-–]/g, '')
  const keyOf = (r: import('../src/lib/models').TableRow) =>
    `${r.law.startsWith('[') ? r.law : normalize(r.law)} ${r.kind} ${r.number}` +
    (r.numberEnd ? `-${r.numberEnd}` : '') + (r.ff === 'ff.' ? ' ff.' : '')
  it('verweis verdict moves row to literatur', () => {
    const rows = [mkRow('[Verweis]', '22', [5])]
    const out = applyAiResults(rows, new Map([[keyOf(rows[0]!), { typ: 'verweis' as const }]]), keyOf, normalize)
    expect(splitRows(out).literatur).toHaveLength(1)
  })
  it('verweis verdict stores the named work; "unbekannt" stays [?]', () => {
    const rows = [mkRow('[Verweis]', '22', [5]), mkRow('[?]', '38', [9])]
    const out = applyAiResults(
      rows,
      new Map([
        [keyOf(rows[0]!), { typ: 'verweis' as const, werk: 'Brox/Walker SchuldR AT' }],
        [keyOf(rows[1]!), { typ: 'verweis' as const, werk: 'unbekannt' }],
      ]),
      keyOf,
      normalize,
    )
    expect(out[0]!.werk).toBe('Brox/Walker SchuldR AT')
    expect(out[1]!.werk).toBeUndefined()
    expect(splitRows(out).literatur).toHaveLength(2)
  })
  it('norm verdict merges into existing law row with aiPages', () => {
    const rows = [mkRow('BGB', '433', [3]), mkRow('[?]', '433', [7])]
    const out = applyAiResults(rows, new Map([[keyOf(rows[1]!), { typ: 'norm' as const, gesetz: 'BGB' }]]), keyOf, normalize)
    expect(out).toHaveLength(1)
    expect(out[0]!.pages).toEqual([3])
    expect(out[0]!.aiPages).toEqual([7])
  })
  it('norm verdict without existing row converts with ** pages', () => {
    const rows = [mkRow('[?]', '812', [9])]
    const out = applyAiResults(rows, new Map([[keyOf(rows[0]!), { typ: 'norm' as const, gesetz: 'BGB' }]]), keyOf, normalize)
    expect(out[0]!.law).toBe('BGB')
    expect(out[0]!.aiPages).toEqual([9])
    expect(out[0]!.pages).toEqual([])
    expect(splitRows(out).main).toHaveLength(1)
  })
  it('unsicher and unbekannt stay uneindeutig', () => {
    const rows = [mkRow('[?]', '1', [1]), mkRow('[?]', '2', [2])]
    const res = new Map([
      [keyOf(rows[0]!), { typ: 'unsicher' as const }],
      [keyOf(rows[1]!), { typ: 'norm' as const, gesetz: 'unbekannt' }],
    ])
    const out = applyAiResults(rows, res, keyOf, normalize)
    expect(splitRows(out).uneindeutig).toHaveLength(2)
  })
})
