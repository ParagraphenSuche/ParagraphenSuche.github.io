/**
 * Some older PDFs (embedded font subsets without ToUnicode tables) extract
 * as glyph codes: ASCII shifted down by 0x1D (space = , "Grundlagen"
 * = "*UXQGODJHQ") with German specials at fixed subset slots. Detected via
 * the control-character ratio and only kept when the result looks like text.
 */
const SHIFT_SPECIALS: Record<number, string> = {
  0x62: 'ä', // italic subset
  0x67: 'Ö', 0x68: 'Ü',
  0x6c: 'ä', 0x7c: 'ö', 0x81: 'ü', 0x89: 'ß',
  0x86: '§', 0xab: '–', 0xb1: '–', 0x2212: '-',
  0xc4: '„', 0xb3: '“',
}

export function fixShiftedEncoding(raw: string): string {
  let ctrl = 0
  let total = 0
  for (const ch of raw) {
    const c = ch.codePointAt(0)!
    if (ch !== '\n' && ch !== '\r' && ch !== '\t') {
      total++
      if (c >= 3 && c <= 0x1f) ctrl++
    }
  }
  if (total < 50 || ctrl / total < 0.1) return raw

  let out = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0)!
    if (ch === '\n' || ch === '\r' || ch === '\t') out += ch
    else if (c >= 3 && c <= 0x61) out += String.fromCodePoint(c + 0x1d)
    else out += SHIFT_SPECIALS[c] ?? ch
  }
  // Keep only when the recovery actually produced readable text.
  const letters = out.match(/[A-Za-zÄÖÜäöüß0-9 .,§()]/g)?.length ?? 0
  return letters / total > 0.85 ? out : raw
}

/**
 * Some PDFs carry the page text twice (a duplicated tagged-content /
 * accessibility layer) — every citation would count double. When the page's
 * opening text reappears later, everything from the reappearance on is the
 * duplicate layer and gets dropped.
 */
export function dropDuplicatedLayer(raw: string): string {
  const probe = raw.trimStart().slice(0, 80)
  if (probe.length < 40) return raw
  const idx = raw.indexOf(probe, 100)
  if (idx > raw.length / 3) return raw.slice(0, idx)
  return raw
}

/**
 * Lines consisting solely of a small number are layout artifacts (margin
 * Randnummern, bare page numbers) — never prose. They must go, or a body
 * sentence ending right before them cannot rejoin across the page break.
 */
export function dropBareNumberLines(raw: string): string {
  return raw
    .split('\n')
    .filter((l) => !/^\d{1,4}$/.test(l.trim()))
    .join('\n')
}

/**
 * Drops a running-header first line ("II. Haftung des Arbeitnehmers 343" /
 * "342 2 Kapitel …"): short, carries a page number at either end, no §, no
 * closing period — and only when the SECOND line does not look the same
 * (protects tables of contents).
 */
export function dropRunningHeader(raw: string): string {
  const nl = raw.indexOf('\n')
  if (nl < 1) return raw
  const first = raw.slice(0, nl).trim()
  const nl2 = raw.indexOf('\n', nl + 1)
  const second = raw.slice(nl + 1, nl2 === -1 ? undefined : nl2).trim()
  const headerLike = (line: string): boolean =>
    line.length > 0 &&
    line.length <= 80 &&
    !line.includes('§') &&
    !/[.!?]$/.test(line) &&
    /[A-Za-zÄÖÜäöüß]/.test(line) &&
    (/^\d{1,4}\s+\S/.test(line) || /\s\d{1,4}$/.test(line))
  if (headerLike(first) && !headerLike(second)) return raw.slice(nl + 1)
  return raw
}

/**
 * Removes repeated headers/footers ("hofmann", "Seite 43", running titles)
 * from the start/end of each page so that citations straddling a page
 * break can be matched across the join. A line qualifies when its
 * digit-insensitive form appears near the edge of at least half the pages.
 */
export function stripRepeatedEdges(rawPages: string[]): string[] {
  if (rawPages.length < 4) return rawPages
  const EDGE = 3 // lines inspected at each page edge
  const norm = (line: string) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

  const counts = new Map<string, number>()
  const pageLines = rawPages.map((p) => p.split('\n'))
  for (const lines of pageLines) {
    const edges = new Set<string>()
    for (const line of [...lines.slice(0, EDGE), ...lines.slice(-EDGE)]) {
      const n = norm(line)
      if (n.length > 0 && n.length <= 80) edges.add(n)
    }
    for (const n of edges) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  const threshold = Math.max(3, Math.ceil(rawPages.length / 2))
  const junk = new Set([...counts].filter(([, c]) => c >= threshold).map(([n]) => n))
  if (junk.size === 0) return rawPages

  return pageLines.map((lines) => {
    let start = 0
    let end = lines.length
    for (let k = 0; k < EDGE && start < end; k++) {
      const n = norm(lines[start]!)
      if (n === '' || junk.has(n)) start++
      else break
    }
    for (let k = 0; k < EDGE && end > start; k++) {
      const n = norm(lines[end - 1]!)
      if (n === '' || junk.has(n)) end--
      else break
    }
    return lines.slice(start, end).join('\n')
  })
}

/**
 * Cleanup of raw per-page PDF text so the citation grammar sees
 * predictable input: one long line, plain spaces, no ligatures,
 * words rejoined across line-break hyphenation.
 */
export function cleanText(raw: string): string {
  let s = raw

  // Resolves ligatures (fi-ligature etc.) and superscript digits (footnote
  // markers may glue onto codes - the extractor compensates).
  s = s.normalize('NFKC')

  // Soft hyphen: pure typography, never meaningful.
  s = s.replace(/\u00AD/g, '')

  // Exotic spaces -> plain space: NBSP, en/em/thin spaces, narrow NBSP,
  // medium mathematical space, word joiner, ideographic space.
  s = s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u2060\u3000]/g, ' ')

  // Dehyphenation across line breaks:
  // lowercase-hyphen-newline-lowercase -> hyphen was a line-break artifact.
  s = s.replace(/([a-zäöüß])-[ \t]*\n[ \t]*([a-zäöüß])/g, '$1$2')
  // Uppercase continuation (EU-\nVerordnung): keep hyphen, drop break.
  s = s.replace(/-[ \t]*\n[ \t]*(?=[A-ZÄÖÜ])/g, '-')

  // Remaining newlines and whitespace runs -> single space.
  s = s.replace(/\s+/g, ' ')

  return s.trim()
}
