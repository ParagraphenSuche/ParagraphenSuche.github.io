import { describe, expect, it } from 'vitest'
import { extractFromPages, type CodeVerdict } from '../src/lib/extractor'
import { groupCitations, toCsv, toMarkdown, compareSectionNumber } from '../src/lib/report'

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
    const { citations } = extractFromPages(['§ 823 Abs. 1 sowie § 826 BGB'], {
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
