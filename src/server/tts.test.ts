import { describe, expect, it } from 'vitest'
import { afterEach, vi } from 'vitest'
import { parsePace } from '../shared/api-types'
import { S16Aligner, applyPace, pickTtsModel, streamSpeech } from './tts'
import { bytesToSamples, samplesToBytes } from './trim'

describe('S16Aligner', () => {
  it('passes even chunks through untouched', () => {
    const a = new S16Aligner()
    expect(Array.from(a.push(new Uint8Array([1, 2, 3, 4]))!)).toEqual([1, 2, 3, 4])
  })
  it('carries an odd trailing byte into the next chunk', () => {
    const a = new S16Aligner()
    expect(Array.from(a.push(new Uint8Array([1, 2, 3]))!)).toEqual([1, 2])
    expect(Array.from(a.push(new Uint8Array([4, 5, 6]))!)).toEqual([3, 4, 5, 6])
  })
  it('handles a one-byte chunk', () => {
    const a = new S16Aligner()
    expect(a.push(new Uint8Array([9]))).toBeNull()
    expect(Array.from(a.push(new Uint8Array([8, 7]))!)).toEqual([9, 8])
    expect(Array.from(a.push(new Uint8Array([6]))!)).toEqual([7, 6])
  })
  it('never yields an odd length', () => {
    const a = new S16Aligner()
    for (const n of [1, 3, 5, 2, 7, 1, 1, 4]) {
      const out = a.push(new Uint8Array(n))
      if (out) expect(out.length % 2).toBe(0)
    }
  })
})

describe('pickTtsModel', () => {
  it('accepts only the two v4 models', () => {
    expect(pickTtsModel('eleven_v4', 'eleven_v4_turbo')).toBe('eleven_v4')
    expect(pickTtsModel('eleven_v4_turbo', 'eleven_v4')).toBe('eleven_v4_turbo')
  })
  it('falls back to the configured default for anything else', () => {
    expect(pickTtsModel('eleven_multilingual_v2', 'eleven_v4_turbo')).toBe('eleven_v4_turbo')
    expect(pickTtsModel(null, 'eleven_v4_turbo')).toBe('eleven_v4_turbo')
    expect(pickTtsModel(undefined, 'eleven_v4')).toBe('eleven_v4')
    expect(pickTtsModel('', 'eleven_v4')).toBe('eleven_v4')
  })
})

describe('applyPace', () => {
  it('puts [slightly faster] in front of the sentence at the brisk pace, and leaves natural alone', () => {
    expect(applyPace('Hello there.', 'brisk')).toBe('[slightly faster] Hello there.')
    expect(applyPace('Hello there.', 'natural')).toBe('Hello there.')
  })
  it("goes in front of the model's own tags, which stay intact", () => {
    expect(applyPace('[laughs] Oh no.', 'brisk')).toBe('[slightly faster] [laughs] Oh no.')
    expect(applyPace('[softly] 你好。', 'brisk')).toBe('[slightly faster] [softly] 你好。')
  })
  it('does not stack a second [slightly faster]', () => {
    expect(applyPace('[slightly faster] Hurry up.', 'brisk')).toBe('[slightly faster] Hurry up.')
  })
})

describe('parsePace', () => {
  it('is brisk unless the client says natural', () => {
    expect(parsePace('natural')).toBe('natural')
    expect(parsePace('brisk')).toBe('brisk')
    for (const v of [undefined, null, '', 'fast', 'NATURAL', 42, {}]) expect(parsePace(v), String(v)).toBe('brisk')
  })
})

describe('streamSpeech', () => {
  const SR = 24_000
  const tone = (ms: number) => Int16Array.from({ length: (SR * ms) / 1000 }, (_, i) => Math.round(12_000 * Math.sin(i / 7 + 0.5)))
  const join = (...p: Int16Array[]) => {
    const out = new Int16Array(p.reduce((n, a) => n + a.length, 0))
    let o = 0
    for (const a of p) (out.set(a, o), (o += a.length))
    return out
  }
  const CFG = { apiKey: 'k', model: 'eleven_v4_turbo', voiceId: 'v' }
  let sentText: string[] = []

  /** A fake ElevenLabs: 100 ms of silence, 400 ms of voice, 350 ms of silence, in odd-sized network chunks. */
  function stubElevenLabs() {
    sentText = []
    const pcm = samplesToBytes(join(new Int16Array(2_400), tone(400), new Int16Array(8_400)))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentText.push(JSON.parse(init.body as string).inputs[0].text)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < pcm.length; i += 3_001) controller.enqueue(pcm.subarray(i, i + 3_001))
            controller.close()
          },
        })
        return new Response(body, { status: 200 })
      }),
    )
  }
  afterEach(() => vi.unstubAllGlobals())

  async function speak(text: string, pace: 'brisk' | 'natural') {
    const parts: Uint8Array[] = []
    for await (const chunk of streamSpeech(text, CFG, pace, new AbortController().signal)) parts.push(chunk)
    const bytes = new Uint8Array(parts.reduce((n, c) => n + c.length, 0))
    let o = 0
    for (const c of parts) (bytes.set(c, o), (o += c.length))
    return { samples: bytesToSamples(bytes), parts }
  }

  it('sends [slightly faster] to ElevenLabs at the brisk pace, in front of the sentence and its tags', async () => {
    stubElevenLabs()
    await speak('[laughs] Oh no.', 'brisk')
    expect(sentText).toEqual(['[slightly faster] [laughs] Oh no.'])
  })

  it('sends the sentence as it is at the natural pace', async () => {
    stubElevenLabs()
    await speak('Oh no.', 'natural')
    expect(sentText).toEqual(['Oh no.'])
  })

  it('trims the silence at both edges of what ElevenLabs sent (100 ms lead, 350 ms trail become 30 ms and 120 ms)', async () => {
    stubElevenLabs()
    const { samples, parts } = await speak('Hello.', 'natural')
    expect((samples.length / SR) * 1000).toBeCloseTo(30 + 400 + 120, -1)
    expect(parts.every((c) => c.length % 2 === 0)).toBe(true)
  })

  it('still throws on a non-200 from ElevenLabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 401 })))
    await expect(speak('Hello.', 'brisk')).rejects.toThrow(/HTTP 401.*quota exceeded/)
  })
})
