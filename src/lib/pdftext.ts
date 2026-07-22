/**
 * PDF text extraction, pdfjs-based but transport-agnostic:
 * callers (browser app / Node e2e test) create the PDFDocumentProxy
 * themselves; this module turns it into per-page raw text.
 */

interface TextItemLike {
  str: string
  hasEOL?: boolean
  height?: number
  transform?: number[]
}

interface TextContentLike {
  items: unknown[]
}

interface PageLike {
  getTextContent(): Promise<TextContentLike>
}

export interface DocumentLike {
  numPages: number
  getPage(n: number): Promise<PageLike>
}

/** Join pdf.js text items into raw page text, preserving line breaks. */
export function itemsToText(items: unknown[]): string {
  let out = ''
  for (const it of items) {
    const item = it as TextItemLike
    if (typeof item.str === 'string') out += item.str
    if (item.hasEOL) out += '\n'
  }
  return out
}

/**
 * Like itemsToText, but moves SMALL-PRINT lines (footnotes, margin numbers —
 * font size well below the page's body size) to the END of the page. Body
 * text interrupted by a footnote block then rejoins across the page break:
 * "… aus § 823 <Fußnoten> || <Folgeseite> BGB, sofern …".
 */
export function itemsToTextBodyFirst(items: unknown[]): string {
  const lines: Array<{ text: string; size: number }> = []
  let cur = ''
  let curSize = 0
  for (const it of items) {
    const item = it as TextItemLike
    if (typeof item.str === 'string') {
      cur += item.str
      const h =
        item.height ??
        (item.transform ? Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) : 0)
      if (item.str.trim().length > 0) curSize = Math.max(curSize, h)
    }
    if (item.hasEOL) {
      lines.push({ text: cur, size: curSize })
      cur = ''
      curSize = 0
    }
  }
  if (cur) lines.push({ text: cur, size: curSize })

  // Body font size: length-weighted median over sized lines.
  const weighted: number[] = []
  for (const l of lines) {
    if (l.size > 0) for (let i = 0; i < l.text.length; i += 20) weighted.push(l.size)
  }
  if (weighted.length === 0) return lines.map((l) => l.text).join('\n')
  weighted.sort((a, b) => a - b)
  const body = weighted[weighted.length >> 1]!

  const main: string[] = []
  const small: string[] = []
  for (const l of lines) {
    if (l.size > 0 && l.size < body * 0.93) small.push(l.text)
    else main.push(l.text)
  }
  if (small.length === 0) return main.join('\n')
  return main.join('\n') + FOOTNOTE_MARK + small.join('\n')
}

/**
 * Separates a page's body text from its small-print (footnote) block.
 * The extractor concatenates all bodies first so sentences interrupted by
 * a footnote apparatus rejoin across the page break.
 */
export const FOOTNOTE_MARK = '\n\u2063FN\u2063\n'

export function splitBodyAndFootnotes(raw: string): { body: string; small: string } {
  const idx = raw.indexOf(FOOTNOTE_MARK)
  if (idx === -1) return { body: raw, small: '' }
  return { body: raw.slice(0, idx), small: raw.slice(idx + FOOTNOTE_MARK.length) }
}

/**
 * Extract raw text of every page (1-based order).
 * Returns raw text — grammar callers run cleanText() per page.
 */
export async function extractPages(
  doc: DocumentLike,
  onProgress?: (page: number, total: number) => void,
): Promise<string[]> {
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    pages.push(itemsToTextBodyFirst(content.items))
    onProgress?.(n, doc.numPages)
  }
  return pages
}

/** True when the document has no usable text layer (likely scanned). */
export function looksScanned(pages: string[]): boolean {
  const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0)
  return totalChars < pages.length * 20
}
