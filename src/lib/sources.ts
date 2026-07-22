/**
 * All network access of the app, backed by the QuantLaw daily mirror of
 * gesetze-im-internet.de (CORS-friendly via raw.githubusercontent.com;
 * gesetze-im-internet.de itself sends no CORS headers).
 *
 * Everything is cached (localStorage when available) — the GitHub API is
 * rate-limited to 60 requests/hour for anonymous browser clients.
 */

const RAW = 'https://raw.githubusercontent.com/QuantLaw/gesetze-im-internet/data/data'
const API = 'https://api.github.com/repos/QuantLaw/gesetze-im-internet'

const DAY = 24 * 60 * 60 * 1000

interface CacheEntry {
  t: number
  v: string
}

function cacheGet(key: string, maxAgeMs: number): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(`ps:${key}`)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    if (Date.now() - entry.t > maxAgeMs) return null
    return entry.v
  } catch {
    return null
  }
}

function cacheSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(`ps:${key}`, JSON.stringify({ t: Date.now(), v: value }))
  } catch {
    // quota exceeded or unavailable — cache is best-effort
  }
}

export class RateLimitError extends Error {
  constructor() {
    super('GitHub-API-Limit erreicht')
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (res.status === 403 || res.status === 429) throw new RateLimitError()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} für ${url}`)
  return res.text()
}

/** All law slugs of the federal-law mirror (cached 7 days). */
export async function fetchTocSlugs(): Promise<string[]> {
  const cached = cacheGet('toc', 7 * DAY)
  if (cached) return JSON.parse(cached) as string[]
  const xml = await fetchText(`${RAW}/toc.xml`)
  const slugs: string[] = []
  for (const m of xml.matchAll(/gesetze-im-internet\.de\/([^/"<]+)\/xml\.zip/g)) {
    slugs.push(m[1]!)
  }
  if (slugs.length < 1000) throw new Error(`toc.xml unerwartet klein (${slugs.length} Einträge)`)
  cacheSet('toc', JSON.stringify(slugs))
  return slugs
}

/** XML filename inside data/items/{slug}/ (cached indefinitely). */
async function lawXmlFilename(slug: string, ref = 'data'): Promise<string> {
  const key = `file:${slug}:${ref}`
  const cached = cacheGet(key, 365 * DAY)
  if (cached) return cached
  const json = await fetchText(`${API}/contents/data/items/${encodeURIComponent(slug)}?ref=${ref}`)
  const entries = JSON.parse(json) as Array<{ name: string }>
  const xml = entries.find((e) => e.name.endsWith('.xml'))
  if (!xml) throw new Error(`Kein XML für ${slug}`)
  cacheSet(key, xml.name)
  return xml.name
}

/** Current law XML from the mirror (cached 1 day). */
export async function fetchCurrentLawXml(slug: string): Promise<string> {
  const key = `law:${slug}`
  const cached = cacheGet(key, DAY)
  if (cached) return cached
  const name = await lawXmlFilename(slug)
  const xml = await fetchText(`${RAW}/items/${encodeURIComponent(slug)}/${name}`)
  cacheSet(key, xml)
  return xml
}

/**
 * SHA of the newest mirror commit for a law at or before the given date
 * (i.e. the law as it stood then). Null when the archive has no snapshot
 * that old. Cached indefinitely.
 */
export async function findSnapshotSha(slug: string, untilIso: string): Promise<string | null> {
  const key = `sha:${slug}:${untilIso}`
  const cached = cacheGet(key, 365 * DAY)
  if (cached) return cached === '-' ? null : cached
  const url = `${API}/commits?sha=data&path=data/items/${encodeURIComponent(
    slug,
  )}&until=${untilIso}T23:59:59Z&per_page=1`
  const json = await fetchText(url)
  const commits = JSON.parse(json) as Array<{ sha: string }>
  const sha = commits[0]?.sha ?? null
  cacheSet(key, sha ?? '-')
  return sha
}

/** Law XML as of a specific mirror commit (cached indefinitely). */
export async function fetchLawXmlAtRef(slug: string, ref: string): Promise<string> {
  const key = `law:${slug}:${ref}`
  const cached = cacheGet(key, 365 * DAY)
  if (cached) return cached
  const name = await lawXmlFilename(slug, ref)
  const xml = await fetchText(
    `https://raw.githubusercontent.com/QuantLaw/gesetze-im-internet/${ref}/data/items/${encodeURIComponent(slug)}/${name}`,
  )
  cacheSet(key, xml)
  return xml
}
