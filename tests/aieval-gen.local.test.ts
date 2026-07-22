import { describe, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages } from '../src/lib/extractor'
import { groupCitations } from '../src/lib/report'
import { LawRegistry } from '../src/lib/registry'
import { fetchTocSlugs } from '../src/lib/sources'
import { canonical } from '../src/lib/models'

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe.skipIf(!existsSync('../FinalTestBook.pdf'))('aieval', () => {
it('generate eval cases', async () => {
  const registry = new LawRegistry(await fetchTocSlugs())
  const books: Array<[string, string, number]> = [
    ['FTB', '../FinalTestBook.pdf', 40],
    ['T0', '../Test Suite/Test0.pdf', 30],
    ['T4', '../Test Suite/Test4.pdf', 30],
    ['LT', '../LongTest.pdf', 20],
  ]
  const out: unknown[] = []
  for (const [tag, path, n] of books) {
    const doc = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise
    const pages = await extractPages(doc)
    const res = extractFromPages(pages, { checkCode: registry.check })
    const rows = groupCitations(res.citations)
    const lawsInDoc = [...new Set(rows.map((r) => r.law).filter((l) => !l.startsWith('[')))].slice(0, 15)
    const pool = res.citations.filter((c) => c.verweis || !c.lawCode)
    const rng = mulberry32(tag.charCodeAt(0) * 100 + 7)
    const picked = new Set<number>()
    while (picked.size < Math.min(n, pool.length)) picked.add(Math.floor(rng() * pool.length))
    for (const i of picked) {
      const c = pool[i]!
      const ctx = res.joinedText.slice(Math.max(0, (c.charIndex ?? 0) - 200), (c.charIndex ?? 0) + c.raw.length + 120).replace(/\s+/g, ' ')
      out.push({
        id: `${tag}-${i}`, book: tag, page: c.page,
        citation: canonical(c), raw: c.raw,
        heuristic: c.verweis ? 'verweis' : 'unknown',
        lawsInDoc, context: ctx, label: null, law: null,
      })
    }
  }
  writeFileSync('/tmp/ai-eval-unlabeled.json', JSON.stringify(out, null, 1))
  console.log('cases:', out.length)
}, 600_000)
})
