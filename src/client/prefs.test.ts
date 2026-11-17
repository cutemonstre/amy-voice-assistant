import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PACE, loadPace, savePace } from './prefs'

function stubStorage(initial: Record<string, string> = {}) {
  const store = { ...initial }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => void (store[k] = v),
  })
  return store
}

afterEach(() => vi.unstubAllGlobals())

describe('the pace preference', () => {
  it('defaults to brisk', () => {
    stubStorage()
    expect(DEFAULT_PACE).toBe('brisk')
    expect(loadPace()).toBe('brisk')
  })
  it('remembers natural, and brisk', () => {
    const store = stubStorage()
    savePace('natural')
    expect(store['voice-chat.pace']).toBe('natural')
    expect(loadPace()).toBe('natural')
    savePace('brisk')
    expect(loadPace()).toBe('brisk')
  })
  it('treats anything unrecognised as brisk', () => {
    stubStorage({ 'voice-chat.pace': 'warp-speed' })
    expect(loadPace()).toBe('brisk')
  })
  it('survives storage that throws (a private window, blocked site data)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadPace()).toBe('brisk')
    expect(() => savePace('natural')).not.toThrow()
  })
  it('works when there is no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadPace()).toBe('brisk')
    expect(() => savePace('natural')).not.toThrow()
  })
})
