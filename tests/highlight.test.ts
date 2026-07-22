import { describe, expect, it } from 'vitest'
import { matchItemIndices } from '../src/lib/highlight'

describe('matchItemIndices', () => {
  it('finds a citation inside a single item', () => {
    const items = ['Der Anspruch aus ', '§ 823 Abs. 1 BGB', ' besteht.']
    expect([...matchItemIndices(items, ['§ 823 Abs. 1 BGB'])]).toEqual([1])
  })
  it('finds a citation spanning several items', () => {
    const items = ['gemäß § 823', ' Abs. 1', ' BGB haftet']
    expect([...matchItemIndices(items, ['§ 823 Abs. 1 BGB'])]).toEqual([0, 1, 2])
  })
  it('whitespace differences do not matter', () => {
    const items = ['§823   Abs.1BGB']
    expect([...matchItemIndices(items, ['§ 823 Abs. 1 BGB'])]).toEqual([0])
  })
  it('finds all occurrences', () => {
    const items = ['§ 90 BGB hier', 'anderes', 'und § 90 BGB dort']
    expect([...matchItemIndices(items, ['§ 90 BGB'])]).toEqual([0, 2])
  })
  it('no match yields empty set', () => {
    expect(matchItemIndices(['nichts', 'hier'], ['§ 1 BGB']).size).toBe(0)
  })
  it('multiple targets accumulate', () => {
    const items = ['§ 1 BGB', 'mitte', '§ 2 BGB']
    expect([...matchItemIndices(items, ['§ 1 BGB', '§ 2 BGB'])]).toEqual([0, 2])
  })
  it('empty items do not break ranges', () => {
    const items = ['§ 823', '', ' Abs. 1 BGB']
    expect([...matchItemIndices(items, ['§ 823 Abs. 1 BGB'])]).toEqual([0, 2])
  })
})
