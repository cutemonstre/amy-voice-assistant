import { describe, expect, it } from 'vitest'
import { isAuthorized, safeEqual } from './auth'

const req = (token?: string) => new Request('http://x/api/turn', { method: 'POST', headers: token ? { 'x-app-token': token } : {} })

describe('safeEqual', () => {
  it('compares strings', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true)
    expect(await safeEqual('abc', 'abd')).toBe(false)
    expect(await safeEqual('abc', 'abcd')).toBe(false)
    expect(await safeEqual('', 'a')).toBe(false)
  })
})

describe('isAuthorized', () => {
  it('has no gate when APP_TOKEN is unset or empty', async () => {
    expect(await isAuthorized(req(), undefined)).toBe(true)
    expect(await isAuthorized(req(), '')).toBe(true)
    expect(await isAuthorized(req('anything'), undefined)).toBe(true)
  })
  it('requires a matching x-app-token when APP_TOKEN is set', async () => {
    expect(await isAuthorized(req('s3cret'), 's3cret')).toBe(true)
    expect(await isAuthorized(req('wrong'), 's3cret')).toBe(false)
    expect(await isAuthorized(req(), 's3cret')).toBe(false)
  })
})
