import { describe, expect, it } from 'vitest'
import { cleanText } from '../src/lib/textclean'

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
