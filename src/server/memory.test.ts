import { describe, expect, it } from 'vitest'
import { checkFact, looksLikeSecret, memoryLines } from './memory'

describe('checkFact', () => {
  it('accepts a short fact and tidies the whitespace', () => {
    expect(checkFact('  Sam is   learning\nMandarin ')).toEqual({ ok: true, fact: 'Sam is learning Mandarin' })
  })
  it('rejects non-strings, empty and over-long facts', () => {
    expect(checkFact(undefined).ok).toBe(false)
    expect(checkFact(42).ok).toBe(false)
    expect(checkFact('   ').ok).toBe(false)
    const long = checkFact('word '.repeat(60))
    expect(long.ok).toBe(false)
    expect(!long.ok && long.reason).toMatch(/too long/)
  })
  it('rejects secrets', () => {
    // fake test values
    for (const secret of [
      'My API key is ' + 'sk-ant-' + 'api03-abcdefghijklmnop',
      'password is hunter2',
      'The token is ' + 'ghp_' + 'abcdefghijklmnopqrstuvwx',
      'Card number ' + '4111 1111 ' + '1111 1111',
      'AWS key ' + 'AKIA' + 'IOSFODNN7EXAMPLE',
      'SSN 123-45-6789',
      'secret: ' + 'a1b2c3d4'.repeat(5),
    ]) {
      expect(checkFact(secret).ok, secret).toBe(false)
    }
  })
  it('does not mistake ordinary facts for secrets', () => {
    for (const fact of [
      'Sam lives in Singapore',
      'Sam is learning Mandarin and wants to order coffee in 2026',
      "Sam's birthday is on 12 March",
      'Sam prefers short answers and a warm tone',
      'Sam works at Acme on version 4.2 of the booking platform',
    ]) {
      expect(looksLikeSecret(fact), fact).toBe(false)
    }
  })
})

describe('memoryLines', () => {
  it('formats [#id] lines on one line each', () => {
    expect(memoryLines([{ id: 3, content: 'a\n b' }, { id: 1, content: 'c' }])).toEqual(['[#3] a b', '[#1] c'])
    expect(memoryLines([])).toEqual([])
  })
})
