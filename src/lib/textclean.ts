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
