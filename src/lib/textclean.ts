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
