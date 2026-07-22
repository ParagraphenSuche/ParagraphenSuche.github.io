import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { extractPages, looksScanned } from '../lib/pdftext'
import { extractFromPages } from '../lib/extractor'
import { applyAiResults, groupCitations, normLabel, sortRowsByStaleness, splitRows } from '../lib/report'
import { buildCases, classifyCases, rowKeyOf } from '../lib/ai'
import { normalizeCodeKey, type ExtractResult } from '../lib/extractor'
import type { TableRow } from '../lib/models'
import { LawRegistry, fallbackRegistry } from '../lib/registry'
import { applyStaleness } from '../lib/staleness'
import { fetchTocSlugs } from '../lib/sources'
import type { AnalysisWarning } from '../lib/models'
import { renderResults } from './table'
import { renderDownloadButtons } from './download'
import { openPagePreview } from './viewer'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

let currentDoc: PDFDocumentProxy | null = null

const form = document.getElementById('analyze-form') as HTMLFormElement
const fileInput = document.getElementById('pdf-input') as HTMLInputElement
const yearInput = document.getElementById('year-input') as HTMLInputElement
const implicitInput = document.getElementById('implicit-input') as HTMLInputElement
const dropRnInput = document.getElementById('drop-rn-input') as HTMLInputElement
const button = document.getElementById('analyze-button') as HTMLButtonElement
const progress = document.getElementById('progress')!
const warningsEl = document.getElementById('warnings')!
const resultsEl = document.getElementById('results')!

function setProgress(msg: string | null): void {
  progress.hidden = msg === null
  progress.textContent = msg ?? ''
}

async function loadRegistry(warnings: AnalysisWarning[]): Promise<LawRegistry> {
  try {
    setProgress('Lade Gesetzesliste …')
    return new LawRegistry(await fetchTocSlugs())
  } catch {
    warnings.push({
      message:
        'Gesetzesliste konnte nicht geladen werden (offline?) – Kürzel werden nur eingeschränkt geprüft.',
    })
    return fallbackRegistry()
  }
}

async function analyze(): Promise<void> {
  const file = fileInput.files?.[0]
  if (!file) return
  button.disabled = true
  resultsEl.hidden = true
  warningsEl.hidden = true

  try {
    const warnings: AnalysisWarning[] = []
    const registry = await loadRegistry(warnings)

    setProgress('Lese PDF …')
    const data = new Uint8Array(await file.arrayBuffer())
    currentDoc?.destroy().catch(() => {})
    const doc = await pdfjs.getDocument({ data }).promise
    currentDoc = doc
    const pages = await extractPages(doc, (page, total) =>
      setProgress(`Lese Seite ${page}/${total} …`),
    )

    if (looksScanned(pages)) {
      warnings.push({
        message:
          'Das PDF enthält (fast) keinen Text – vermutlich ein Scan ohne Texterkennung. Es können keine Zitate gefunden werden.',
      })
    }

    setProgress('Suche Gesetzeszitate …')
    // The implicit law is NOT attached deterministically (book-chapter/
    // statute degeneracy) — it only serves as context for the AI pass.
    const result = extractFromPages(pages, {
      checkCode: registry.check,
      dropRnContext: dropRnInput.checked,
    })
    warnings.push(...result.warnings)

    const rows = groupCitations(result.citations)

    const year = yearInput.value ? parseInt(yearInput.value, 10) : undefined
    if (year !== undefined && !Number.isNaN(year)) {
      await applyStaleness(rows, registry, year, setProgress)
      sortRowsByStaleness(rows)
    }

    setProgress(null)
    state = { rows, result, registry, year, docTitle: file.name }
    rerender()
  } catch (err) {
    setProgress(`Fehler: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    button.disabled = false
  }
}

interface State {
  rows: TableRow[]
  result: ExtractResult
  registry: LawRegistry
  year?: number
  docTitle: string
}
let state: State | null = null

function rerender(): void {
  if (!state) return
  const { rows, docTitle } = state
  renderResults(resultsEl, rows, [], warningsEl, (row, page) => {
    if (!currentDoc) return
    void openPagePreview(
      currentDoc,
      page,
      row.pageSources[page] ?? [`${row.kind} ${row.number}`],
      `${normLabel(row)} ${row.law}`,
    )
  })
  renderDownloadButtons(resultsEl, rows, docTitle)
  renderAiSection()
}

function renderAiSection(): void {
  document.getElementById('ai-section')?.remove()
  if (!state) return
  const { uneindeutig } = splitRows(state.rows)
  if (uneindeutig.length === 0) return

  const box = document.createElement('div')
  box.id = 'ai-section'
  box.innerHTML = `
    <h3>KI-Klassifikation</h3>
    <p class="hint-text">Klassifiziert die ${uneindeutig.length} uneindeutigen Fälle mit Gemini
    (${state.year !== undefined ? 'inkl. anschließender Änderungsprüfung' : 'ohne Änderungsprüfung'}).
    Es werden nur kurze Textausschnitte übertragen, nie das PDF.</p>
    <div class="field">
      <label for="gemini-key">Gemini-API-Key <span class="hint">(<a href="https://aistudio.google.com/apikey" rel="noopener" target="_blank">kostenlos erstellen</a>; wird nur lokal gespeichert)</span></label>
      <input type="password" id="gemini-key" autocomplete="off" />
    </div>
    <button type="button" id="ai-run">Uneindeutige Fälle mit KI klassifizieren</button>
    <button type="button" id="ai-cancel" hidden>Abbrechen</button>
    <progress id="ai-progress" max="1" value="0" hidden></progress>
    <span id="ai-status"></span>`
  const anchor = document.getElementById('tbl-uneindeutig')
  const target = anchor?.parentElement ?? resultsEl
  if (anchor) {
    // place after the uneindeutig table (heading -> subtitle -> table)
    let node: Element | null = anchor
    for (let i = 0; i < 3 && node?.nextElementSibling; i++) node = node.nextElementSibling
    node?.insertAdjacentElement('afterend', box)
  } else {
    target.append(box)
  }

  const keyInput = box.querySelector('#gemini-key') as HTMLInputElement
  keyInput.value = localStorage.getItem('ps:gemini-key') ?? ''
  const runBtn = box.querySelector('#ai-run') as HTMLButtonElement
  const cancelBtn = box.querySelector('#ai-cancel') as HTMLButtonElement
  const prog = box.querySelector('#ai-progress') as HTMLProgressElement
  const status = box.querySelector('#ai-status') as HTMLSpanElement

  runBtn.addEventListener('click', () => {
    const apiKey = keyInput.value.trim()
    if (!apiKey) {
      status.textContent = 'Bitte zuerst einen API-Key eintragen.'
      return
    }
    localStorage.setItem('ps:gemini-key', apiKey)
    void runAi(apiKey, runBtn, cancelBtn, prog, status)
  })
}

async function runAi(
  apiKey: string,
  runBtn: HTMLButtonElement,
  cancelBtn: HTMLButtonElement,
  prog: HTMLProgressElement,
  status: HTMLSpanElement,
): Promise<void> {
  if (!state) return
  const { rows, result, registry } = state
  const { main, uneindeutig } = splitRows(rows)
  const cases = buildCases(uneindeutig, result.citations, result.joinedText)
  const controller = new AbortController()
  runBtn.disabled = true
  cancelBtn.hidden = false
  cancelBtn.onclick = () => controller.abort()
  prog.hidden = false
  prog.value = 0
  status.textContent = `0/${cases.length}`

  try {
    const candidateLaws = [...new Set(main.map((r) => r.law))].slice(0, 15)
    const results = await classifyCases(cases, {
      apiKey,
      implicitLaw: implicitInput.value.trim() || undefined,
      candidateLaws,
      signal: controller.signal,
      onProgress: (done, total) => {
        prog.value = done / total
        status.textContent = `${done}/${total}`
      },
    })
    state.rows = applyAiResults(rows, results, rowKeyOf, normalizeCodeKey)
    if (state.year !== undefined) {
      status.textContent = 'Änderungsprüfung für KI-zugeordnete Normen …'
      await applyStaleness(state.rows, registry, state.year, (m) => (status.textContent = m))
    }
    sortRowsByStaleness(state.rows)
    rerender()
  } catch (err) {
    status.textContent = `Fehler: ${err instanceof Error ? err.message : String(err)}`
    runBtn.disabled = false
    cancelBtn.hidden = true
    prog.hidden = true
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  void analyze()
})
