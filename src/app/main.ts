import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { extractPages, looksScanned } from '../lib/pdftext'
import { extractFromPages } from '../lib/extractor'
import { groupCitations, normLabel, sortRowsByStaleness } from '../lib/report'
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
    const implicitCode = implicitInput.value.trim() || undefined
    const result = extractFromPages(pages, {
      checkCode: registry.check,
      implicitCode,
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
    renderResults(resultsEl, rows, warnings, warningsEl, (row, page) => {
      if (!currentDoc) return
      void openPagePreview(
        currentDoc,
        page,
        row.pageSources[page] ?? [`${row.kind} ${row.number}`],
        `${normLabel(row)} ${row.law}`,
      )
    })
    renderDownloadButtons(resultsEl, rows, file.name)
  } catch (err) {
    setProgress(`Fehler: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    button.disabled = false
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  void analyze()
})
