import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages, normalizeCodeKey } from '../src/lib/extractor'
import { groupCitations, rowSpanWidth } from '../src/lib/report'
import { LawRegistry } from '../src/lib/registry'
import { fetchTocSlugs } from '../src/lib/sources'

describe.skipIf(!existsSync('../Test Suite/Test4.pdf'))('gold4', () => {
it('cross-check extraction against Gesetzesverzeichnis', async () => {
  const registry = new LawRegistry(await fetchTocSlugs())
  const doc = await getDocument({ data: new Uint8Array(readFileSync('../Test Suite/Test4.pdf')) }).promise
  const pages = await extractPages(doc)

  // --- parse the register (pages 493-510, PDF numbering) ---
  interface Entry { law: string; kind: string; num: string; ff: boolean; line: string; section: string }
  const entries: Entry[] = []
  let law = ''
  let section = ''
  const headings: string[] = []
  for (let p = 492; p < 510; p++) {
    for (const raw of pages[p]!.split('\n')) {
      const line = raw.trim()
      if (!line || /^\d+$/.test(line)) continue
      const sec = /^([0-9]+|[IVX]+)\.\s+(.{3,40})$/.exec(line)
      if (sec && !line.includes('§')) { section = line; continue }
      const key = /^(§§?|Artt?\.?)\s?(\d+)(?:\s?(?!ff?\s?\.)([a-z]))?\s?(?:(ff?)\s?\.)?\s?\.?\s?(?=§|Art)/.exec(line)
      if (key) {
        entries.push({ law, kind: key[1]!.startsWith('§') ? '§' : 'Art.', num: key[2]! + (key[3] ?? ''), ff: !!key[4], line, section })
        continue
      }
      const junk = /^(?:[IVXL]{1,6}(?:\s|$))|^Fn\.|^Gesetzesverzeichnis$|hin\.$/
      if (!line.includes('§') && /^[A-ZÄÖÜ][A-Za-z0-9ÄÖÜäöüß./()–,-]{1,40}(?:\s[A-Za-zÄÖÜäöüß0-9./()–,-]{1,20}){0,3}$/.test(line) && !junk.test(line) && /[A-Za-z]{2}/.test(line)) {
        law = line; headings.push(`${section} | ${line}`)
      }
    }
  }
  console.log('REGISTER: entries=', entries.length, 'laws=', new Set(entries.map(e => e.law)).size)
  console.log('HEADINGS:\n' + headings.join('\n'))

  // --- our extraction ---
  const res = extractFromPages(pages, { checkCode: registry.check })
  const rows = groupCitations(res.citations)
  const byLaw = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = r.law.startsWith('[') ? r.law : normalizeCodeKey(r.law)
    if (!byLaw.has(k)) byLaw.set(k, [])
    byLaw.get(k)!.push(r)
  }
  const matchIn = (list: typeof rows | undefined, e: Entry): boolean => {
    if (!list) return false
    const n = parseInt(e.num, 10)
    return list.some(r => {
      if (r.kind !== e.kind) return false
      if (r.number.replace(/\s/g, '') === e.num) return true
      const start = parseInt(r.number, 10)
      const end = r.numberEnd ? parseInt(r.numberEnd, 10) : r.ff ? start + (r.ff === 'ff.' ? 20 : 1) : start
      return n >= start && n <= end && rowSpanWidth(r) <= 200
    })
  }
  const ambiguous = [...(byLaw.get('[?]') ?? []), ...(byLaw.get('[Verweis]') ?? [])]
  let lawHit = 0, ambHit = 0
  const misses: string[] = []
  for (const e of entries) {
    if (matchIn(byLaw.get(normalizeCodeKey(e.law)), e)) lawHit++
    else if (matchIn(ambiguous, e)) ambHit++
    else misses.push(`${e.law} ${e.kind} ${e.num}${e.ff ? ' ff.' : ''}  [${e.section}] :: ${e.line.slice(0, 60)}`)
  }
  const n = entries.length
  console.log(`DETECTED with correct law: ${lawHit}/${n} (${(lawHit / n * 100).toFixed(1)}%)`)
  console.log(`DETECTED as ambiguous (AI pending): ${ambHit}/${n} (${(ambHit / n * 100).toFixed(1)}%)`)
  console.log(`TOTAL detected: ${lawHit + ambHit}/${n} (${((lawHit + ambHit) / n * 100).toFixed(1)}%)`)
  console.log(`NOT FOUND (${misses.length}):`)
  console.log(misses.join('\n'))
  writeFileSync('../Test Suite/gold4-report.txt', misses.join('\n'))

  // Gold floor (2026-07-24): 1010/1017 detected; the 7 open entries are
  // register-only (the §§ are discussed, never literally cited in the body:
  // BGB 219/220/459/461/492 ff./579, GG Art. 2 — verified by hand).
  expect(lawHit + ambHit).toBeGreaterThanOrEqual(1010)
  expect(entries.length).toBeGreaterThanOrEqual(1000)
}, 900_000)
})
