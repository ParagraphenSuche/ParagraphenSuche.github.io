import { describe, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages } from '../src/lib/extractor'
import { groupCitations } from '../src/lib/report'
import { LawRegistry } from '../src/lib/registry'
import { fetchTocSlugs } from '../src/lib/sources'
import { canonical } from '../src/lib/models'

describe.skipIf(!existsSync('../FinalTestBook.pdf'))('FinalTestBook audit', () => {
it('analyze FinalTestBook', async () => {
  const registry = new LawRegistry(await fetchTocSlugs())
  const doc = await getDocument({ data: new Uint8Array(readFileSync('../FinalTestBook.pdf')) }).promise
  const pages = await extractPages(doc)
  console.log('pages:', pages.length)
  console.log('IDENT p1:', JSON.stringify(pages[0]?.slice(0, 150)))
  console.log('IDENT p3:', JSON.stringify(pages[2]?.slice(0, 150)))

  const res = extractFromPages(pages, { checkCode: registry.check })
  const rows = groupCitations(res.citations)
  console.log('citations:', res.citations.length, 'rows:', rows.length)

  // all [?] rows
  const unknownRows = rows.filter((r) => r.law === '[?]')
  console.log('=== [?] rows:', unknownRows.length, '===')
  for (const r of unknownRows) {
    const srcs = Object.entries(r.pageSources).slice(0, 2).map(([p, s]) => `p${p}: ${s[0]}`)
    console.log(`  ${r.kind} ${r.number}${r.numberEnd ? '–' + r.numberEnd : ''}${r.ff ?? ''} | pages ${r.pages.slice(0, 6).join(',')} | ${srcs.join(' || ')}`)
  }
  console.log('=== unresolved codes ===')
  for (const [code, n] of res.unresolvedCodes) console.log(`  ${code} (${n}x)`)

  // law distribution
  const dist = new Map<string, number>()
  for (const r of rows) dist.set(r.law, (dist.get(r.law) ?? 0) + 1)
  console.log('=== laws ===', JSON.stringify([...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)))

  // persist for the sampling steps
  writeFileSync('/tmp/ftb-citations.json', JSON.stringify(res.citations.map(c => ({
    page: c.page, raw: c.raw, canonical: canonical(c), law: c.lawCode ?? null, implicit: c.implicit
  }))))
  writeFileSync('/tmp/ftb-rows.json', JSON.stringify(rows))
}, 300_000)
})
