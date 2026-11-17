import { describe, expect, it } from 'vitest'
import { resolveSttConfig } from './stt'

describe('resolveSttConfig', () => {
  it('uses ElevenLabs Scribe by default when the key is present', () => {
    const { config, warn } = resolveSttConfig({
      STT_PROVIDER: 'elevenlabs',
      STT_MODEL_ELEVENLABS: 'scribe_v2',
      ELEVENLABS_API_KEY: 'x',
      OPENROUTER_API_KEY: 'y',
    })
    expect(config).toMatchObject({ provider: 'elevenlabs', model: 'scribe_v2', apiKey: 'x' })
    expect(warn).toBeUndefined()
  })

  it('falls back to OpenRouter with a warning when the ElevenLabs key is missing', () => {
    const { config, warn } = resolveSttConfig({ STT_PROVIDER: 'elevenlabs', OPENROUTER_API_KEY: 'y', STT_MODEL_OPENROUTER: 'microsoft/mai-transcribe-2' })
    expect(config).toMatchObject({ provider: 'openrouter', model: 'microsoft/mai-transcribe-2', apiKey: 'y' })
    expect(warn).toMatch(/No ELEVENLABS_API_KEY/)
  })

  it('honours STT_PROVIDER=openrouter without a warning, even when an ElevenLabs key exists', () => {
    const { config, warn } = resolveSttConfig({ STT_PROVIDER: 'openrouter', ELEVENLABS_API_KEY: 'x', OPENROUTER_API_KEY: 'y' })
    expect(config).toMatchObject({ provider: 'openrouter', apiKey: 'y' })
    expect(warn).toBeUndefined()
  })

  it('defaults to elevenlabs and to per-provider models when vars are missing', () => {
    expect(resolveSttConfig({ ELEVENLABS_API_KEY: 'x' }).config).toMatchObject({ provider: 'elevenlabs', model: 'scribe_v2' })
    expect(resolveSttConfig({ STT_PROVIDER: 'openrouter' }).config.model).toBe('microsoft/mai-transcribe-2')
  })

  it('has no language setting at all: the language is always auto-detected', () => {
    const { config } = resolveSttConfig({ ELEVENLABS_API_KEY: 'x', OPENROUTER_API_KEY: 'y' })
    expect(config).not.toHaveProperty('language')
  })
})
