import { describe, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages } from '../src/lib/extractor'
import { groupCitations, splitRows } from '../src/lib/report'
import { LawRegistry } from '../src/lib/registry'
import { fetchTocSlugs } from '../src/lib/sources'

const DIR = '../Test Suite'

describe.skipIf(!existsSync(`${DIR}/Test0.pdf`))('batch', () => {
  it('all 10 books', async () => {
    const registry = new LawRegistry(await fetchTocSlugs())
    for (let i = 0; i <= 9; i++) {
      const doc = await getDocument({ data: new Uint8Array(readFileSync(`${DIR}/Test${i}.pdf`)) }).promise
      const pages = await extractPages(doc)
      const ident = (pages.slice(0, 6).join(' ').match(/[A-ZÄÖÜ][a-zäöüß]+[^\n]{0,80}/) ?? [''])[0]
      const t0 = Date.now()
      const res = extractFromPages(pages, { checkCode: registry.check })
      const rows = groupCitations(res.citations)
      const { main, review, verweise } = splitRows(rows)
      const unk = rows.filter((r) => r.law === '[?]')
      console.log(`## Test${i}: ${pages.length}p | cit=${res.citations.length} rows=${rows.length} (main=${main.length} rev=${review.length} verw=${verweise.length} unk=${unk.length}) | ${Date.now() - t0}ms`)
      console.log(`   ident: ${JSON.stringify(pages[2]?.slice(0, 100) ?? ident)}`)
      const dist = new Map<string, number>()
      for (const r of rows) dist.set(r.law, (dist.get(r.law) ?? 0) + 1)
      console.log('   laws:', JSON.stringify([...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)))
      const codes = [...res.unresolvedCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      if (codes.length) console.log('   unresolved:', JSON.stringify(codes))
      for (const r of unk.slice(0, 6)) {
        const src = Object.entries(r.pageSources)[0]
        console.log(`   ?| ${r.kind} ${r.number}${r.numberEnd ? '–' + r.numberEnd : ''}${r.ff ? ' ' + r.ff : ''} @${r.pages.slice(0, 4).join(',')} :: ${src ? src[1][0]?.slice(0, 55) : ''}`)
      }
    }
  }, 900_000)
})
