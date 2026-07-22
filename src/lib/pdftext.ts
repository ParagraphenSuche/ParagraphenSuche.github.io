/**
 * PDF text extraction, pdfjs-based but transport-agnostic:
 * callers (browser app / Node e2e test) create the PDFDocumentProxy
 * themselves; this module turns it into per-page raw text.
 */

interface TextItemLike {
  str: string
  hasEOL?: boolean
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
    pages.push(itemsToText(content.items))
    onProgress?.(n, doc.numPages)
  }
  return pages
}

/** True when the document has no usable text layer (likely scanned). */
export function looksScanned(pages: string[]): boolean {
  const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0)
  return totalChars < pages.length * 20
}
