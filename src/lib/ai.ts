/**
 * AI classification of ambiguous citations (norm vs. literature reference)
 * via the Gemini API. Evaluated 2026-07 on 112 hand-labeled cases from four
 * textbooks: gemini-flash-latest at context window ±400/240 — 100% type
 * accuracy, 94.7% law inference (±200/120: 99.1%; ±1600/960 degrades —
 * distractor citations). Batch 28 shows no degradation vs 14 on Gemini
 * (halves request count: quota + wall time). See Test Suite/ai-eval/ (local).
 */
import type { Citation, TableRow } from './models'
import { normalizeCodeKey } from './extractor'

/** Primary and fallback model (separate free-tier quotas). Eval 2026-07:
 * flash 99.1% / flash-lite 95.5% type accuracy. */
export const AI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest']
export const AI_BATCH = 28

export class QuotaError extends Error {
  constructor() {
    super(
      'Gemini-Kontingent erschöpft (Free Tier). Später erneut versuchen – das Tageskontingent wird um Mitternacht (Pacific Time) zurückgesetzt.',
    )
  }
}

export type AiVerdict = 'norm' | 'verweis' | 'unsicher'

export interface AiCase {
  rowKey: string
  citation: string
  context: string
}

export interface AiResult {
  typ: AiVerdict
  gesetz?: string
  /** For "verweis": the cited work (author/title) the § belongs to. */
  werk?: string
}

const SYSTEM = `Du bist ein Klassifikator für deutsche juristische Texte. Du bekommst Textausschnitte aus juristischen Büchern, jeweils mit einem markierten (»…«) §-Zitat. Entscheide für jedes:

"typ":
- "norm": Paragraph/Artikel eines GESETZES — auch ohne Gesetzeskürzel (Lehrbuch-Fließtext, Prüfungsschemata), und auch wenn ein GESETZESKOMMENTAR zitiert wird (MünchKomm/MüKo, Staudinger, Soergel, Palandt/Grüneberg, Erman, BR = Bamberger/Roth, PWW, Jauernig kommentieren das BGB; Zöller, Thomas/Putzo die ZPO; Demharter die GBO — der kommentierte § IST eine Norm dieses Gesetzes).
- "verweis": KAPITEL eines Buches — Lehrbuchzitate (Brox/Walker, Looschelders, Medicus, Larenz, Esser/Weyers, Köhler, Stadler, Flume, Baur/Stürner, Wolff-Raiser, Westermann; Werktitel wie "BGB AT", "SchuldR BT", "BR" bezeichnen LEHRBÜCHER, deren "§ N" Kapitel sind, oft mit "S. <Seite>" oder Gliederungsangaben "§ 66 IV 3"), Selbstverweise ("siehe oben § 5 Rn. 39"), Sachregister-Einträge ("§ 32 IV a").
- "unsicher": wenn nicht hinreichend erkennbar.

"gesetz": bei "norm" das Gesetz aus den Kandidaten oder "unbekannt"; sonst null. Der Nutzer gibt das HAUPTGESETZ des Buches an: Normen OHNE Kürzel im Fließtext, in Prüfungsschemata oder in Kommentarzitaten dieses Rechtsgebiets gehören im Zweifel zu diesem Hauptgesetz — antworte dann mit dem Hauptgesetz, NICHT mit "unbekannt". "unbekannt" nur, wenn der Kontext gegen das Hauptgesetz spricht und kein anderes Gesetz erkennbar ist.

"werk": bei "verweis" das zitierte Werk, kurz als Autor(en) plus ggf. Titel ("Brox/Walker SchuldR AT", "Baur-Stürner Sachenrecht", "dieses Werk" bei Selbstverweisen/Registereinträgen, "unbekannt" wenn nicht erkennbar); sonst null.

Antworte NUR mit JSON: {"ergebnisse": [{"nr": <Nummer>, "typ": "...", "gesetz": ..., "werk": ...}, ...]}`

/** Row key used to match AI results back to rows. */
export function rowKeyOf(row: TableRow): string {
  const lawKey = row.law.startsWith('[') ? row.law : normalizeCodeKey(row.law)
  return (
    `${lawKey} ${row.kind} ${row.number}` +
    (row.numberEnd ? `-${row.numberEnd}` : '') +
    (row.ff === 'ff.' ? ' ff.' : '')
  )
}

/**
 * One representative context per ambiguous row: the first citation of the
 * row, ±400/240 chars from the joined text, target marked with »«.
 */
export function buildCases(
  rows: TableRow[],
  citations: Citation[],
  joinedText: string,
): AiCase[] {
  const byKey = new Map<string, Citation>()
  for (const c of citations) {
    const law = c.verweis ? '[Verweis]' : c.lawCode ? normalizeCodeKey(c.lawCode) : '[?]'
    const key =
      `${law} ${c.ref.kind} ${c.ref.number}` +
      (c.ref.numberEnd ? `-${c.ref.numberEnd}` : '') +
      (c.ref.ff === 'ff.' ? ' ff.' : '')
    if (!byKey.has(key)) byKey.set(key, c)
  }
  const cases: AiCase[] = []
  for (const row of rows) {
    const key = rowKeyOf(row)
    const c = byKey.get(key)
    if (!c || c.charIndex === undefined) continue
    const start = Math.max(0, c.charIndex - 400)
    const end = Math.min(joinedText.length, c.charIndex + c.raw.length + 240)
    const context =
      joinedText.slice(start, c.charIndex) +
      '»' +
      joinedText.slice(c.charIndex, c.charIndex + c.raw.length) +
      '«' +
      joinedText.slice(c.charIndex + c.raw.length, end)
    cases.push({ rowKey: key, citation: `${row.kind} ${row.number}`, context })
  }
  return cases
}

export interface ClassifyOptions {
  apiKey: string
  implicitLaw?: string
  candidateLaws: string[]
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** Classify all cases in batches; returns rowKey -> result (partial on abort). */
export async function classifyCases(
  cases: AiCase[],
  opts: ClassifyOptions,
): Promise<Map<string, AiResult>> {
  const results = new Map<string, AiResult>()
  let modelIdx = 0
  let lastRequestAt = 0
  for (let start = 0; start < cases.length; start += AI_BATCH) {
    if (opts.signal?.aborted) break
    // Pace requests (free tier is per-minute limited).
    const wait = lastRequestAt + 7000 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequestAt = Date.now()
    const batch = cases.slice(start, start + AI_BATCH)
    const parts = batch.map(
      (c, i) => `[${i + 1}] Markiertes Zitat: ${c.citation}\nText: …${c.context}…`,
    )
    const user =
      `Hauptgesetz dieses Buches (Nutzerangabe): ${opts.implicitLaw || 'unbekannt'}\n` +
      `Kandidaten-Gesetze: ${opts.candidateLaws.slice(0, 15).join(', ')}, unbekannt\n\n` +
      parts.join('\n\n')
    let out: RawEntry[] | null = null
    while (modelIdx < AI_MODELS.length) {
      try {
        out = await callGemini(AI_MODELS[modelIdx]!, user, opts.apiKey, opts.signal)
        break
      } catch (e) {
        if (e instanceof QuotaError && modelIdx + 1 < AI_MODELS.length) {
          modelIdx++ // fall back to the next model (separate quota)
          continue
        }
        throw e
      }
    }
    if (out) {
      for (const e of out) {
        const idx = (e.nr ?? 0) - 1
        const c = batch[idx]
        if (c && (e.typ === 'norm' || e.typ === 'verweis' || e.typ === 'unsicher')) {
          results.set(c.rowKey, {
            typ: e.typ,
            gesetz: e.gesetz ?? undefined,
            werk: e.werk ?? undefined,
          })
        }
      }
    }
    opts.onProgress?.(Math.min(start + AI_BATCH, cases.length), cases.length)
  }
  return results
}

interface RawEntry {
  nr?: number
  typ?: string
  gesetz?: string | null
  werk?: string | null
}

async function callGemini(
  model: string,
  user: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<RawEntry[] | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0, response_mime_type: 'application/json' },
  })
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) return null
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    }).catch((e) => {
      if (signal?.aborted) return null
      throw e
    })
    if (!res) return null
    if (res.status === 429) {
      if (attempt >= 3) throw new QuotaError() // persistent -> switch model
      // Free-tier limits are mostly per-minute: honor the server's
      // suggested retry delay when present, else back off generously.
      let delayMs = 20000 * (attempt + 1)
      try {
        const err = (await res.json()) as {
          error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> }
        }
        const retry = err.error?.details?.find((d) => d['@type']?.includes('RetryInfo'))
        const secs = retry?.retryDelay ? parseFloat(retry.retryDelay) : NaN
        if (!Number.isNaN(secs) && secs > 0) delayMs = Math.min(secs * 1000 + 1500, 90000)
      } catch {
        // body unreadable — keep default backoff
      }
      await new Promise((r) => setTimeout(r, delayMs))
      continue
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)))
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Gemini API ${res.status}: ${text.slice(0, 200)}`)
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null
    try {
      const parsed = JSON.parse(text) as { ergebnisse?: RawEntry[] }
      return parsed.ergebnisse ?? null
    } catch {
      return null
    }
  }
  return null
}
