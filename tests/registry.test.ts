import { describe, expect, it } from 'vitest'
import { LawRegistry } from '../src/lib/registry'

// Slug list shaped like the real toc (slug = lowercased abbreviation,
// sometimes with year suffix or umlaut substitution).
const registry = new LawRegistry([
  'bgb', 'zpo', 'stgb', 'gg', 'bimschg', 'bdsg_2018', 'bdsg_1990', 'g10_2001',
  'stvo_2013', 'sgb_5', 'hgb', 'vvg_2008',
])

describe('LawRegistry.resolve', () => {
  it('exact slug match', () => {
    expect(registry.resolve('BGB')?.slug).toBe('bgb')
    expect(registry.resolve('BImSchG')?.slug).toBe('bimschg')
  })
  it('year-suffixed slug picks newest', () => {
    expect(registry.resolve('BDSG')?.slug).toBe('bdsg_2018')
  })
  it('alias table wins (G 10)', () => {
    expect(registry.resolve('G 10')?.slug).toBe('g10_2001')
  })
  it('EU instruments resolve without slug', () => {
    const dsgvo = registry.resolve('DSGVO')
    expect(dsgvo?.eu).toBe(true)
    expect(dsgvo?.slug).toBeUndefined()
    expect(registry.resolve('GDPR')?.display).toBe('DSGVO')
    expect(registry.resolve('AEUV')?.eu).toBe(true)
  })
  it('generic EU regulation pattern', () => {
    expect(registry.resolve('VO (EU) Nr. 1215/2012')?.eu).toBe(true)
    expect(registry.resolve('VO (EU) 2019/1150')?.eu).toBe(true)
  })
  it('journals and court reporters are rejected', () => {
    expect(registry.resolve('NJW')).toBeNull()
    expect(registry.resolve('BGHZ')).toBeNull()
    expect(registry.check('NJW')).toBe('reject')
  })
  it('unknown stays unknown', () => {
    expect(registry.resolve('XYZG')).toBeNull()
    expect(registry.check('XYZG')).toBe('unknown')
  })
})
