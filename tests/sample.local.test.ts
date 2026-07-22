import { describe, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages } from '../src/lib/extractor'
import { groupCitations } from '../src/lib/report'
import { LawRegistry } from '../src/lib/registry'
import { fetchTocSlugs } from '../src/lib/sources'
import { canonical } from '../src/lib/models'
import { cleanText, stripRepeatedEdges } from '../src/lib/textclean'

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe.skipIf(!existsSync('../FinalTestBook.pdf'))('FinalTestBook audit', () => {
it('audit + samples', async () => {
  const registry = new LawRegistry(await fetchTocSlugs())
  const doc = await getDocument({ data: new Uint8Array(readFileSync('../FinalTestBook.pdf')) }).promise
  const t0 = Date.now()
  const pages = await extractPages(doc)
  const tExtract = Date.now() - t0
  const t1 = Date.now()
  const res = extractFromPages(pages, { checkCode: registry.check })
  const rows = groupCitations(res.citations)
  const tParse = Date.now() - t1
  console.log(`TIMING pages=${pages.length} extract=${tExtract}ms parse+group=${tParse}ms citations=${res.citations.length} rows=${rows.length}`)

  // FULL [?] audit list with representative raws
  const unknown = rows.filter((r) => r.law === '[?]')
  console.log(`=== ALL [?] ROWS (${unknown.length}) ===`)
  for (const r of unknown) {
    const src = Object.entries(r.pageSources)[0]
    console.log(`?| ${r.kind} ${r.number}${r.numberEnd ? '–' + r.numberEnd : ''}${r.ff ? ' ' + r.ff : ''} @${r.pages.join(',')} :: ${src ? src[1][0]?.slice(0, 70) : ''}`)
  }

  // (a) 100-citation sample with page-attribution self-check
  const cleaned = stripRepeatedEdges(pages).map(cleanText)
  const rng = mulberry32(42)
  const sample: number[] = []
  while (sample.length < 100) {
    const i = Math.floor(rng() * res.citations.length)
    if (!sample.includes(i)) sample.push(i)
  }
  console.log('=== SAMPLE A (100 citations) ===')
  for (const i of sample.sort((x, y) => x - y)) {
    const c = res.citations[i]!
    const raw = c.raw.replace(/\s+/g, ' ')
    const onPage = cleaned[c.page - 1]!.includes(raw) ||
      (cleaned[c.page - 1]! + ' ' + (cleaned[c.page] ?? '')).includes(raw)
    console.log(`A| p${c.page} ${onPage ? 'OK ' : 'MISS'} [${raw.slice(0, 60)}] => ${canonical(c)}${c.implicit ? ' (impl)' : ''}`)
  }

  // (b) 20 random pages for manual inspection + their table entries
  const rng2 = mulberry32(7)
  const pageSample: number[] = []
  while (pageSample.length < 20) {
    const p = 1 + Math.floor(rng2() * pages.length)
    if (!pageSample.includes(p)) pageSample.push(p)
  }
  pageSample.sort((a, b) => a - b)
  console.log('=== SAMPLE B PAGES ===', pageSample.join(','))
  for (const p of pageSample) {
    const here = res.citations.filter((c) => c.page === p)
    console.log(`B| page ${p}: ${here.map((c) => canonical(c)).join(' ;; ') || '(keine)'}`)
  }
  writeFileSync('/tmp/ftb-pages.json', JSON.stringify(pageSample))
}, 300_000)
})
