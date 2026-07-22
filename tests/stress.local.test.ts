import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages } from '../src/lib/extractor'
import { groupCitations } from '../src/lib/report'

const BOOK = fileURLToPath(new URL('../../FinalTestBook.pdf', import.meta.url))

describe.skipIf(!existsSync(BOOK))('stress FinalTestBook.pdf', () => {
  it('processes the whole book in reasonable time', async () => {
    const t0 = Date.now()
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await getDocument({ data: new Uint8Array(readFileSync(BOOK)) }).promise
    const pages = await extractPages(doc)
    const tExtract = Date.now() - t0
    const t1 = Date.now()
    const { citations } = extractFromPages(pages, { checkCode: () => 'known' })
    const rows = groupCitations(citations)
    const tParse = Date.now() - t1
    console.log(
      `pages=${pages.length} citations=${citations.length} rows=${rows.length} extract=${tExtract}ms parse=${tParse}ms`,
    )
    expect(pages.length).toBeGreaterThan(50)
    expect(citations.length).toBeGreaterThan(100)
  }, 300_000)
})
