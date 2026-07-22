import { describe, expect, it } from 'vitest'
import { cleanText, stripRepeatedEdges } from '../src/lib/textclean'

describe('stripRepeatedEdges', () => {
  it('removes repeated footers and headers', () => {
    const pages = [
      'hofmann\nInhalt eins.\nSeite 1',
      'hofmann\nInhalt zwei.\nSeite 2',
      'hofmann\nInhalt drei.\nSeite 3',
      'hofmann\nInhalt vier.\nSeite 4',
    ]
    const out = stripRepeatedEdges(pages)
    expect(out[0]).toBe('Inhalt eins.')
    expect(out[3]).toBe('Inhalt vier.')
  })
  it('keeps unique lines and short documents untouched', () => {
    const pages = ['A\nB', 'C\nD']
    expect(stripRepeatedEdges(pages)).toEqual(pages)
  })
})

describe('cleanText', () => {
  it('resolves fi ligature', () => {
    expect(cleanText('Pﬂichtverletzung triﬀt')).toBe('Pflichtverletzung trifft')
  })
  it('removes soft hyphens', () => {
    expect(cleanText('Scha­densersatz')).toBe('Schadensersatz')
  })
  it('maps NBSP and narrow NBSP to space', () => {
    expect(cleanText('§ 823 BGB')).toBe('§ 823 BGB')
  })
  it('joins lowercase hyphenation across lines', () => {
    expect(cleanText('Scha-\ndensersatz')).toBe('Schadensersatz')
  })
  it('keeps hyphen before uppercase continuation', () => {
    expect(cleanText('EU-\nVerordnung')).toBe('EU-Verordnung')
  })
  it('collapses whitespace', () => {
    expect(cleanText('§ 823\n\nAbs.  1   BGB')).toBe('§ 823 Abs. 1 BGB')
  })
  it('converts superscript footnote digits (NFKC)', () => {
    expect(cleanText('BGB¹')).toBe('BGB1')
  })
})
