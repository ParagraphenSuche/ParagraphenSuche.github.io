/**
 * Maps citation snippets back to pdf.js text items so the page preview can
 * draw highlight boxes. Whitespace is unreliable across items, so matching
 * happens on a whitespace-free normalized stream with per-item ranges.
 */

function normalize(s: string): string {
  return s.normalize('NFKC').replace(/\u00AD/g, '').replace(/\s+/g, '')
}

/**
 * Indices of items covered by any occurrence of any target snippet.
 * `itemStrings` are the raw pdf.js item strings in reading order.
 */
export function matchItemIndices(itemStrings: string[], targets: string[]): Set<number> {
  const parts = itemStrings.map(normalize)
  const starts: number[] = []
  let stream = ''
  for (const p of parts) {
    starts.push(stream.length)
    stream += p
  }
  const hit = new Set<number>()

  for (const target of targets) {
    const t = normalize(target)
    if (t.length < 2) continue
    let from = 0
    for (;;) {
      const idx = stream.indexOf(t, from)
      if (idx === -1) break
      const end = idx + t.length
      for (let i = 0; i < parts.length; i++) {
        const s = starts[i]!
        const e = s + parts[i]!.length
        if (e > idx && s < end && parts[i]!.length > 0) hit.add(i)
      }
      from = idx + 1
    }
  }
  return hit
}
