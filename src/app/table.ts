import type { AnalysisWarning, TableRow } from '../lib/models'
import { statusLabel } from '../lib/report'

const BADGE_CLASS: Record<string, string> = {
  PARA_CHANGED: 'stale',
  PARA_UNCHANGED: 'ok',
  LAW_CHANGED: 'warn',
  POSSIBLY_STALE: 'warn',
  UNCHANGED: 'ok',
  UNKNOWN: 'unknown',
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function pagesCell(row: TableRow): HTMLTableCellElement {
  const td = el('td')
  const all = [
    ...row.pages.map((p) => ({ p, implied: false })),
    ...row.impliedPages.map((p) => ({ p, implied: true })),
  ].sort((a, b) => a.p - b.p)
  td.textContent = all.map((e) => (e.implied ? `${e.p}*` : `${e.p}`)).join(', ')
  return td
}

export function renderResults(
  container: HTMLElement,
  rows: TableRow[],
  warnings: AnalysisWarning[],
  warningsContainer: HTMLElement,
): void {
  container.replaceChildren()
  warningsContainer.replaceChildren()
  warningsContainer.hidden = warnings.length === 0
  if (warnings.length > 0) {
    const ul = el('ul')
    for (const w of warnings) ul.append(el('li', w.message))
    warningsContainer.append(el('strong', 'Hinweise:'), ul)
  }

  const heading = el('h2', `Gefundene Normen (${rows.length})`)
  const table = el('table')
  const thead = el('thead')
  const headRow = el('tr')
  for (const h of ['Gesetz', 'Norm', 'Zitat-Varianten', 'Seiten', 'Status', 'Hinweis']) {
    headRow.append(el('th', h))
  }
  thead.append(headRow)
  const tbody = el('tbody')

  for (const row of rows) {
    const tr = el('tr')
    const law = el('td', row.law)
    if (row.implicitOnly) {
      law.append(' ')
      law.append(el('span', '(implizit)', 'badge info'))
    }
    tr.append(law)
    tr.append(el('td', `${row.kind} ${row.number}`))
    tr.append(el('td', row.variants.join('; ')))
    tr.append(pagesCell(row))
    const status = el('td')
    if (row.staleness) {
      status.append(el('span', statusLabel(row), `badge ${BADGE_CLASS[row.staleness.status]}`))
    } else {
      status.textContent = '–'
    }
    tr.append(status)
    tr.append(el('td', row.staleness?.note ?? ''))
    tbody.append(tr)
  }

  table.append(thead, tbody)
  const legend = el(
    'p',
    '* Seite zitiert die Norm nur mittelbar über ein Bereichszitat (z. B. „§§ 812–822“ oder „ff.“).',
  )
  legend.style.fontSize = '0.85rem'
  legend.style.color = '#666'
  container.append(heading, table, legend)
  container.hidden = false
}
