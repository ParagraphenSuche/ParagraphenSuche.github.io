import type { AnalysisWarning, TableRow } from '../lib/models'
import { normLabel, splitRows, statusLabel } from '../lib/report'

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

export type PageClickHandler = (row: TableRow, page: number) => void

function pagesCell(row: TableRow, onPageClick?: PageClickHandler): HTMLTableCellElement {
  const td = el('td')
  const all = [
    ...row.pages.map((p) => ({ p, mark: '' })),
    ...row.impliedPages.map((p) => ({ p, mark: '*' })),
    ...(row.aiPages ?? []).map((p) => ({ p, mark: '**' })),
  ].sort((a, b) => a.p - b.p)
  all.forEach((e, i) => {
    if (i > 0) td.append(', ')
    const label = `${e.p}${e.mark}`
    if (onPageClick) {
      const a = el('a', label)
      a.href = '#'
      a.title = `Seite ${e.p} mit markierter Fundstelle anzeigen`
      a.addEventListener('click', (ev) => {
        ev.preventDefault()
        onPageClick(row, e.p)
      })
      td.append(a)
    } else {
      td.append(label)
    }
  })
  return td
}

export function renderResults(
  container: HTMLElement,
  allRows: TableRow[],
  warnings: AnalysisWarning[],
  warningsContainer: HTMLElement,
  onPageClick?: PageClickHandler,
): void {
  container.replaceChildren()
  warningsContainer.replaceChildren()
  warningsContainer.hidden = warnings.length === 0
  if (warnings.length > 0) {
    const ul = el('ul')
    for (const w of warnings) ul.append(el('li', w.message))
    warningsContainer.append(el('strong', 'Hinweise:'), ul)
  }

  const { main, review, literatur, uneindeutig } = splitRows(allRows)
  const sections: Array<{ id: string; label: string }> = []
  renderTable(container, main, `Gefundene Normen (${main.length})`, onPageClick, undefined, 'tbl-main')
  sections.push({ id: 'tbl-main', label: `Normen (${main.length})` })
  if (review.length > 0) {
    renderTable(
      container,
      review,
      `Bereichszitate & „ff.“ (${review.length}) – bitte selbst prüfen`,
      onPageClick,
      'Diese Zitate umfassen viele bzw. unbestimmt viele Normen und werden nicht einzeln geprüft.',
      'tbl-review',
    )
    sections.push({ id: 'tbl-review', label: `Bereichszitate (${review.length})` })
  }
  if (literatur.length > 0) {
    renderTable(
      container,
      literatur,
      `Literaturverweise (${literatur.length}) – KI-klassifiziert`,
      onPageClick,
      'Diese §-Angaben beziehen sich laut KI auf Kapitel zitierter Werke (z. B. „Brox/Walker, BGB AT, § 38, Rn. 1“), nicht auf Gesetze.',
      'tbl-literatur',
      'Werk',
    )
    sections.push({ id: 'tbl-literatur', label: `Literaturverweise (${literatur.length})` })
  }
  if (uneindeutig.length > 0) {
    renderTable(
      container,
      uneindeutig,
      `Uneindeutige Klassifizierungen (${uneindeutig.length})`,
      onPageClick,
      'Zitate ohne erkennbares Gesetz: Norm eines Gesetzes ohne Kürzel, Literatur-/Kapitelverweis oder Sonstiges. Mit KI klassifizierbar.',
      'tbl-uneindeutig',
    )
    sections.push({ id: 'tbl-uneindeutig', label: `Uneindeutig (${uneindeutig.length})` })
  }
  renderSideNav(sections)

  const legend = el(
    'p',
    '* Seite über Bereichszitat (z. B. „§§ 812–822“, „ff.“) · ** Seite KI-klassifiziert.',
  )
  legend.style.fontSize = '0.85rem'
  legend.style.color = '#666'
  container.append(legend)
  container.hidden = false
}

function renderSideNav(sections: Array<{ id: string; label: string }>): void {
  document.getElementById('side-nav')?.remove()
  if (sections.length < 2) return
  const nav = document.createElement('nav')
  nav.id = 'side-nav'
  nav.setAttribute('aria-label', 'Tabellen')
  for (const s of sections) {
    const a = document.createElement('a')
    a.href = `#${s.id}`
    a.textContent = s.label
    a.addEventListener('click', (e) => {
      e.preventDefault()
      document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    nav.append(a)
  }
  document.body.append(nav)
}

function renderTable(
  container: HTMLElement,
  rows: TableRow[],
  title: string,
  onPageClick?: PageClickHandler,
  subtitle?: string,
  id?: string,
  lawHeader = 'Gesetz',
): void {
  const heading = el('h2', title)
  if (id) heading.id = id
  const table = el('table')
  const thead = el('thead')
  const headRow = el('tr')
  for (const h of [lawHeader, 'Norm', 'Zitat-Varianten', 'Seiten', 'Status', 'Hinweis']) {
    headRow.append(el('th', h))
  }
  thead.append(headRow)
  const tbody = el('tbody')

  for (const row of rows) {
    const tr = el('tr')
    const law = el('td', row.werk ?? row.law)
    if (row.implicitOnly) {
      law.append(' ')
      law.append(el('span', '(implizit)', 'badge info'))
    }
    tr.append(law)
    tr.append(el('td', normLabel(row)))
    tr.append(el('td', row.variants.join('; ')))
    tr.append(pagesCell(row, onPageClick))
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
  container.append(heading)
  if (subtitle) {
    const sub = el('p', subtitle)
    sub.style.fontSize = '0.9rem'
    sub.style.color = '#666'
    container.append(sub)
  }
  container.append(table)
}
