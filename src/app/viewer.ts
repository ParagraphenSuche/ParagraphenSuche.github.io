/**
 * Page-preview modal: renders one PDF page to a canvas and highlights the
 * text items belonging to the citation(s) that placed this page in the row.
 */
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { matchItemIndices } from '../lib/highlight'

interface TextItemLike {
  str: string
  transform: number[]
  width: number
}

let overlay: HTMLDivElement | null = null

function buildOverlay(): HTMLDivElement {
  const el = document.createElement('div')
  el.id = 'viewer-overlay'
  el.innerHTML = `
    <div id="viewer-box">
      <div id="viewer-head">
        <span id="viewer-title"></span>
        <button type="button" id="viewer-close" aria-label="Schließen">×</button>
      </div>
      <div id="viewer-body"><div id="viewer-canvas-wrap"></div></div>
    </div>`
  el.addEventListener('click', (e) => {
    if (e.target === el) closeViewer()
  })
  el.querySelector('#viewer-close')!.addEventListener('click', closeViewer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeViewer()
  })
  document.body.append(el)
  return el
}

export function closeViewer(): void {
  overlay?.remove()
  overlay = null
}

export async function openPagePreview(
  doc: PDFDocumentProxy,
  pageNo: number,
  targets: string[],
  title: string,
): Promise<void> {
  closeViewer()
  overlay = buildOverlay()
  overlay.querySelector('#viewer-title')!.textContent = `${title} – Seite ${pageNo}`
  const wrap = overlay.querySelector('#viewer-canvas-wrap') as HTMLDivElement

  const page = await doc.getPage(pageNo)
  const maxWidth = Math.min(860, window.innerWidth - 80)
  const base = page.getViewport({ scale: 1 })
  const scale = maxWidth / base.width
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  wrap.style.width = `${viewport.width}px`
  wrap.style.height = `${viewport.height}px`
  wrap.append(canvas)

  const ctx = canvas.getContext('2d')!
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
  }).promise

  // Highlight boxes over the matched text items.
  const content = await page.getTextContent()
  const items = content.items as TextItemLike[]
  const hits = matchItemIndices(
    items.map((it) => it.str ?? ''),
    targets,
  )
  let firstBox: HTMLDivElement | null = null
  for (const i of hits) {
    const it = items[i]!
    const tx = pdfjs.Util.transform(viewport.transform, it.transform)
    const fontHeight = Math.hypot(tx[2]!, tx[3]!)
    const box = document.createElement('div')
    box.className = 'viewer-highlight'
    box.style.left = `${tx[4]!}px`
    box.style.top = `${tx[5]! - fontHeight}px`
    box.style.width = `${it.width * scale}px`
    box.style.height = `${fontHeight * 1.15}px`
    wrap.append(box)
    if (!firstBox) firstBox = box
  }

  firstBox?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
}
