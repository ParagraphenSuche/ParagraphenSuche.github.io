import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPages } from '../src/lib/pdftext'
import { extractFromPages, normalizeCodeKey } from '../src/lib/extractor'
import { groupCitations, rowSpanWidth } from '../src/lib/report'
import { LawRegistry } from '../src/lib/registry'
import { fetchTocSlugs } from '../src/lib/sources'

/**
 * Gold cross-check for Test10 (Bereicherungsrecht, Springer 2020): its
 * Gesetzesverzeichnis (pages 149-151) lists every cited norm. Layout is
 * column-scrambled (keys and "§ x Rn. y" locations come in blocks), so a
 * key line = a line starting with §/§§ whose first number is NOT directly
 * followed by Rn./Fn. (those are chapter locations).
 */
describe.skipIf(!existsSync('../Test Suite/Test10.pdf'))('gold10', () => {
it('cross-check extraction against Gesetzesverzeichnis', async () => {
  const registry = new LawRegistry(await fetchTocSlugs())
  const doc = await getDocument({ data: new Uint8Array(readFileSync('../Test Suite/Test10.pdf')) }).promise
  const pages = await extractPages(doc)

  interface Entry { law: string; num: string; line: string }
  const entries: Entry[] = []
  let law = ''
  const headings: string[] = []
  const junk = /^(?:[IVXL]{1,6}(?:\s|$))|^Fn\.|^Rn\.|^Gesetzesverzeichnis$|hin\.$|^https|Springer|Bereicherungsrecht,/
  for (let p = 148; p < 151; p++) {
    for (const raw of pages[p]!.split('\n')) {
      const line = raw.trim()
      if (!line || /^\d+$/.test(line)) continue
      const m = /^(§§?)\s?(\d{1,4}\s?[a-z]?)(.*)$/.exec(line)
      if (m) {
        const first = m[2]!.replace(/\s/g, '')
        const rest = m[3]!
        if (/^\s?(?:Rn|Fn)\./.test(rest)) continue // location line
        entries.push({ law, num: first, line })
        // enumerations ("§§ 196, 197 a.F.") — collect further plain numbers
        const more = rest.match(/^(?:\s?,\s?\d{1,4}[a-z]?)+/)?.[0] ?? ''
        for (const em of more.matchAll(/\d{1,4}[a-z]?/g)) entries.push({ law, num: em[0], line })
        continue
      }
      if (!line.includes('§') && /^[A-ZÄÖÜ][A-Za-z0-9ÄÖÜäöüß./()–,-]{1,40}(?:\s[A-Za-zÄÖÜäöüß0-9./()–,-]{1,20}){0,3}$/.test(line) && !junk.test(line) && /[A-Za-z]{2}/.test(line)) {
        law = line
        headings.push(line)
      }
    }
  }
  console.log('REGISTER: entries=', entries.length, '| laws:', headings.join(', '))

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
    return list.some((r) => {
      if (r.kind !== '§') return false
      if (r.number.replace(/\s/g, '') === e.num) return true
      const start = parseInt(r.number, 10)
      const end = r.numberEnd ? parseInt(r.numberEnd, 10) : r.ff ? start + (r.ff === 'ff.' ? 20 : 1) : start
      return n >= start && n <= end && rowSpanWidth(r) <= 200
    })
  }
  const ambiguous = [...(byLaw.get('[?]') ?? []), ...(byLaw.get('[Verweis]') ?? [])]
  let lawHit = 0
  let ambHit = 0
  const misses: string[] = []
  for (const e of entries) {
    if (matchIn(byLaw.get(normalizeCodeKey(e.law)), e)) lawHit++
    else if (matchIn(ambiguous, e)) ambHit++
    else misses.push(`${e.law} § ${e.num} :: ${e.line.slice(0, 55)}`)
  }
  const n = entries.length
  console.log(`DETECTED with correct law: ${lawHit}/${n}`)
  console.log(`DETECTED as ambiguous (AI pending): ${ambHit}/${n}`)
  console.log(`TOTAL detected: ${lawHit + ambHit}/${n} (${(((lawHit + ambHit) / n) * 100).toFixed(1)}%)`)
  console.log(`NOT FOUND (${misses.length}):`)
  console.log(misses.join('\n'))
  // Gold floor (2026-07-24): every register entry is detected (184/184).
  expect(n).toBeGreaterThanOrEqual(180)
  expect(lawHit + ambHit).toBe(n)
  // and the register pages themselves are dropped from extraction
  expect(res.warnings.some((w) => w.message.includes('Verzeichnis'))).toBe(true)
}, 900_000)
})
