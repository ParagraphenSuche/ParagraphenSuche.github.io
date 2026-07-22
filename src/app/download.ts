import type { TableRow } from '../lib/models'
import { toCsv, toHtml, toMarkdown } from '../lib/report'

function download(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function renderDownloadButtons(
  container: HTMLElement,
  rows: TableRow[],
  docTitle: string,
): void {
  const wrap = document.createElement('p')
  const mk = (label: string, fn: () => void) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    btn.style.marginRight = '0.5rem'
    btn.addEventListener('click', fn)
    return btn
  }
  const base = docTitle.replace(/\.pdf$/i, '')
  wrap.append(
    mk('CSV herunterladen', () =>
      download(`${base}-normen.csv`, 'text/csv;charset=utf-8', toCsv(rows)),
    ),
    mk('Markdown herunterladen', () =>
      download(`${base}-normen.md`, 'text/markdown;charset=utf-8', toMarkdown(rows, docTitle)),
    ),
    mk('HTML herunterladen', () =>
      download(`${base}-normen.html`, 'text/html;charset=utf-8', toHtml(rows, docTitle)),
    ),
  )
  container.append(wrap)
}
