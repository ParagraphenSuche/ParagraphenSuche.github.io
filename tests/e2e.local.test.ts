/**
 * Local end-to-end test against real (copyrighted) test PDFs that live in the
 * parent iCloud folder and are NEVER committed. Skipped when absent (CI).
 *
 * Golden data derived by manually reading the first pages of each PDF.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages, type CodeVerdict } from '../src/lib/extractor'
import { groupCitations } from '../src/lib/report'

const SMALL = fileURLToPath(new URL('../../SmallTest.pdf', import.meta.url))
const LONG = fileURLToPath(new URL('../../LongTest.pdf', import.meta.url))

const KNOWN = new Set(
  ['BGB', 'StGB', 'ZPO', 'GG', 'HGB', 'VVG', 'GmbHG', 'AktG', 'EStG', 'ProdHaftG', 'StVG', 'PflVG', 'EGBGB', 'FamFG', 'GVG', 'InsO', 'WEG', 'DSGVO', 'AEUV'].map((c) =>
    c.toLowerCase(),
  ),
)
const checkCode = (code: string): CodeVerdict =>
  KNOWN.has(code.toLowerCase().replace(/[\s.\-]/g, '')) ? 'known' : 'unknown'

async function loadPdfPages(path: string): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(readFileSync(path))
  const doc = await getDocument({ data }).promise
  return extractPages(doc)
}

describe.skipIf(!existsSync(SMALL))('e2e SmallTest.pdf', () => {
  it('extracts the golden citation table (manually verified, all 4 pages)', async () => {
    const pages = await loadPdfPages(SMALL)
    expect(pages).toHaveLength(4)

    const { citations } = extractFromPages(pages, { checkCode, implicitCode: 'BGB' })
    const rows = groupCitations(citations)
    const key = (r: (typeof rows)[number]) =>
      `${r.law} ${r.number}${r.numberEnd ? `–${r.numberEnd}` : ''}`
    const byNumber = new Map(rows.map((r) => [key(r), r]))

    // Page 1 (printed "Seite 9")
    expect(byNumber.get('BGB 1')?.pages).toContain(1) // vgl. § 1 BGB
    expect(byNumber.get('BGB 104')?.pages).toContain(1) // §§ 104 ff. BGB
    expect(byNumber.get('BGB 104')?.variants.join(' ')).toContain('ff.')

    // Page 2 (printed "Seite 10")
    expect(byNumber.get('BGB 194')?.pages).toContain(2) // vgl. § 194 BGB
    expect(byNumber.get('BGB 90')?.pages).toContain(2) // § 90 BGB
    expect(byNumber.get('BGB 241')?.pages).toContain(2) // § 241 Abs. 1 BGB
    expect(byNumber.get('BGB 311')?.pages).toContain(2) // §§ 311 ff. BGB
    // Ranges get their own rows: §§ 677–687, 812–822, 823–853, 985–1007 BGB
    expect(byNumber.get('BGB 677–687')?.pages).toContain(2)
    expect(byNumber.get('BGB 812–822')?.pages).toContain(2)
    expect(byNumber.get('BGB 823–853')?.pages).toContain(2)
    expect(byNumber.get('BGB 985–1007')?.pages).toContain(2)

    // Page 3 (printed "Seite 11")
    expect(byNumber.get('BGB 241–432')?.pages).toContain(3) // §§ 241–432 BGB
    expect(byNumber.get('BGB 433–853')?.pages).toContain(3) // §§ 433–853 BGB
    expect(byNumber.get('BGB 433')?.pages).toEqual([3, 4]) // § 433 Abs. 1 S. 1 / Abs. 2 / plain
    expect(byNumber.get('BGB 929')?.pages).toContain(3) // § 929 S. 1 BGB (2×)

    // Page 4 (printed "Seite 12")
    expect(byNumber.get('BGB 929')?.pages).toContain(4) // § 929 S. 1 / § 929 BGB
    expect(byNumber.get('BGB 398')?.pages).toContain(4) // § 398 BGB + iVm chain
    expect(byNumber.get('BGB 413')?.pages).toContain(4) // § 413 BGB i.V.m. § 398 BGB

    // Implied coverage: §§ 241–432 BGB (page 3) also covers the separately
    // cited §§ 241, 311, 398, 413; §§ 433–853 covers § 433 (already direct
    // on p3) and the range rows inside it.
    expect(byNumber.get('BGB 241')?.impliedPages).toContain(3)
    expect(byNumber.get('BGB 311')?.impliedPages).toContain(3)
    expect(byNumber.get('BGB 398')?.impliedPages).toContain(3)
    expect(byNumber.get('BGB 413')?.impliedPages).toContain(3)
    expect(byNumber.get('BGB 677–687')?.impliedPages).toContain(3)

    // No junk rows: every row is BGB (implicit or explicit) on this document.
    for (const r of rows) {
      expect(r.law).toBe('BGB')
    }

    // Roman/long-form must not create duplicate rows for the same key.
    const keys = rows.map((r) => `${r.kind} ${key(r)}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe.skipIf(!existsSync(LONG))('e2e LongTest.pdf (Skript BGB AT)', () => {
  it('extracts the golden citations of the first 10 pages (manually verified)', async () => {
    const pages = await loadPdfPages(LONG)
    const { citations } = extractFromPages(pages, { checkCode, implicitCode: 'BGB' })
    const rows = groupCitations(citations)
    const get = (n: string) =>
      rows.find((r) => r.law === 'BGB' && r.number === n && !r.ff && !r.numberEnd)
    const getFf = (n: string) => rows.find((r) => r.law === 'BGB' && r.number === n && r.ff === 'ff.')
    const getRange = (n: string) =>
      rows.find((r) => r.law === 'BGB' && r.number === n && r.numberEnd)

    // Table of contents (PDF page 2) + intro (page 3)
    expect(get('133')?.pages).toContain(2) // §§ 133, 157 BGB
    expect(get('157')?.pages).toContain(2)
    expect(get('154')?.pages).toContain(2) // §§ 154, 155 BGB
    expect(getFf('104')?.pages).toEqual(expect.arrayContaining([2, 3])) // §§ 104 ff. BGB
    expect(getRange('116')?.variants.join(' ')).toContain('116–118') // §§ 116-118 BGB
    expect(get('119')?.pages).toEqual(expect.arrayContaining([2, 8, 9])) // § 119 I / II BGB
    expect(getFf('21')?.pages).toContain(3) // §§ 21 ff. BGB
    expect(getFf('194')?.pages).toEqual(expect.arrayContaining([2, 3])) // §§ 194 ff. BGB

    // Roman shorthand with Satz: "§ 147 I 2 BGB" (page 4)
    expect(get('147')?.pages).toContain(4)
    expect(get('147')?.variants.join(' ')).toContain('§ 147 Abs. 1 S. 2 BGB')
    expect(get('130')?.pages).toContain(4) // § 130 I BGB
    expect(get('241a')?.pages).toContain(5) // vgl. auch § 241a BGB

    // Enumerations with Roman details: §§ 311 II, 241 II BGB (page 7)
    expect(get('311')?.pages).toContain(7)
    expect(get('241')?.pages).toContain(7)
    // §§ 433 II, 156 S. 1 BGB (page 8)
    expect(get('433')?.pages).toEqual(expect.arrayContaining([3, 6, 8, 9, 10]))
    expect(get('156')?.pages).toEqual(expect.arrayContaining([8, 9]))

    // Code-less citation resolved via implicit BGB: analog §§ 521, 599, 690 (page 8)
    expect(get('521')?.pages).toContain(8)
    expect(get('521')?.implicitOnly).toBe(true)
    expect(get('599')?.pages).toContain(8)
    expect(get('690')?.pages).toContain(8)

    expect(get('145')?.pages).toEqual(expect.arrayContaining([8, 9, 10])) // § 145 BGB
    expect(getFf('145')?.pages).toEqual(expect.arrayContaining([4, 6])) // §§ 145 ff. BGB
    expect(get('164')?.pages).toContain(6) // § 164 I BGB
    expect(getFf('164')?.pages).toContain(2) // §§ 164 ff. BGB
    expect(get('598')?.pages).toContain(7) // § 598 BGB
    expect(get('280')?.pages).toContain(7) // § 280 I BGB
    expect(get('122')?.pages).toEqual(expect.arrayContaining([2, 9])) // § 122 (I) BGB

    // User-reported cases (pages 23/33/42/43):
    const egbgb = rows.find((r) => r.law === 'EGBGB' && r.number === '246a')
    expect(egbgb?.pages).toContain(43) // Art. 246a § 1 II 2 EGBGB
    expect(egbgb?.kind).toBe('Art.')
    const gg4 = rows.find((r) => r.law === 'GG' && r.number === '4')
    expect(gg4?.pages).toContain(42) // Art. 4 I, II GG
    expect(get('119')?.variants.join(' ')).toContain('Alt. 1') // § 119 I, 1. Alt. BGB
    expect(get('121')?.pages).toContain(33) // §§ 121 bzw. 124 BGB
    expect(get('121')?.implicitOnly).toBe(false)
    expect(get('124')?.pages).toContain(33)
    expect(get('126')?.variants.join(' ')).toContain('§ 126 Abs. 3 BGB') // § 126 III BGB
  })
})
