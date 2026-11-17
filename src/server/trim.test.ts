import { describe, expect, it } from 'vitest'
import { EdgeTrimmer, bytesToSamples, samplesToBytes, trimEdges } from './trim'

const SR = 24_000
const samplesFor = (ms: number) => Math.round((SR * ms) / 1000)

/** Silence: all zeros. */
const silence = (ms: number) => new Int16Array(samplesFor(ms))
/** A loud tone (about -6 dBFS). */
const tone = (ms: number, amplitude = 16_000) => {
  const out = new Int16Array(samplesFor(ms))
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SR + 0.7)) // phase offset: the first sample is never 0
  return out
}
/** A quiet hiss just below -40 dBFS (peak 300, the threshold is 327.7). */
const hiss = (ms: number, peak = 300) => {
  const out = new Int16Array(samplesFor(ms))
  for (let i = 0; i < out.length; i++) out[i] = i % 2 ? peak : -peak
  return out
}
const join = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const ms = (samples: number) => (samples / SR) * 1000

/** Run the trimmer over `clip`, fed in chunks of `chunkSamples` (so the window edges fall in odd places), and return everything it sent. */
function run(clip: Int16Array, chunkSamples = 4_800, trimmer = new EdgeTrimmer()) {
  const sent: Uint8Array[] = []
  for (let i = 0; i < clip.length; i += chunkSamples) {
    const out = trimmer.push(samplesToBytes(clip.subarray(i, i + chunkSamples)))
    if (out) sent.push(out)
  }
  const tail = trimmer.end()
  if (tail) sent.push(tail)
  const bytes = new Uint8Array(sent.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of sent) {
    bytes.set(c, o)
    o += c.length
  }
  return { samples: bytesToSamples(bytes), chunks: sent, stats: trimmer.stats }
}

/** Length of the quiet stretch (all samples below the threshold) at the start and at the end of a clip, in ms. */
function edges(clip: Int16Array, threshold = 327) {
  let lead = 0
  while (lead < clip.length && Math.abs(clip[lead]!) < threshold) lead++
  let trail = 0
  while (trail < clip.length && Math.abs(clip[clip.length - 1 - trail]!) < threshold) trail++
  return { leadMs: ms(lead), trailMs: ms(trail) }
}

describe('byte and sample conversion', () => {
  it('round-trips signed 16-bit little-endian samples', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345])
    expect(Array.from(bytesToSamples(samplesToBytes(samples)))).toEqual(Array.from(samples))
    expect(Array.from(samplesToBytes(new Int16Array([0x0102])))).toEqual([0x02, 0x01])
  })
  it('does not care where in a buffer the bytes start', () => {
    const buffer = new Uint8Array([9, 0x02, 0x01, 0xff, 0xff])
    expect(Array.from(bytesToSamples(buffer.subarray(1)))).toEqual([0x0102, -1])
  })
  it('ignores a dangling odd byte', () => {
    expect(bytesToSamples(new Uint8Array([1, 0, 7])).length).toBe(1)
  })
})

describe('EdgeTrimmer: leading silence', () => {
  it('drops leading silence but keeps 30 ms before the first loud window', () => {
    const { samples, stats } = run(join(silence(100), tone(500), silence(10)))
    expect(edges(samples).leadMs).toBeGreaterThanOrEqual(29)
    expect(edges(samples).leadMs).toBeLessThanOrEqual(31)
    expect(ms(stats.leadDropped)).toBeCloseTo(70, 0) // 100 ms of silence, 30 ms kept
  })

  it('keeps the whole lead-in when the silence is shorter than 30 ms', () => {
    const { samples, stats } = run(join(silence(20), tone(200)))
    expect(edges(samples).leadMs).toBeGreaterThanOrEqual(19)
    expect(stats.leadDropped).toBe(0)
  })

  it('keeps the sound itself exactly: every loud sample comes through, in order', () => {
    const voice = tone(300)
    const { samples } = run(join(silence(120), voice, silence(400)))
    const start = edges(samples).leadMs * (SR / 1000)
    expect(Array.from(samples.subarray(Math.round(start), Math.round(start) + voice.length))).toEqual(Array.from(voice))
  })

  it('does not wait for the end of the stream to send the first sound', () => {
    const trimmer = new EdgeTrimmer()
    expect(trimmer.push(samplesToBytes(silence(100)))).toBeNull() // dropped, nothing to send
    const out = trimmer.push(samplesToBytes(tone(50)))
    expect(out).not.toBeNull() // sent at once, before end()
    expect(ms(bytesToSamples(out!).length)).toBeGreaterThanOrEqual(70) // 30 ms lead-in + the 50 ms of tone (whole windows)
  })

  it('a quiet hiss under the threshold counts as silence, a single loud sample counts as sound', () => {
    const quiet = run(join(hiss(200), tone(100)))
    expect(ms(quiet.stats.leadDropped)).toBeCloseTo(170, 0)
    const click = new Int16Array(samplesFor(100))
    click[samplesFor(60)] = 5_000
    const withClick = run(join(click, tone(100)))
    expect(ms(withClick.stats.leadDropped)).toBeLessThanOrEqual(40) // it started at the click window (50-60 ms), keeping 30 ms before it
  })
})

describe('EdgeTrimmer: trailing silence', () => {
  it('trims trailing silence to at most 120 ms', () => {
    const { samples, stats } = run(join(tone(400), silence(370)))
    expect(edges(samples).trailMs).toBeGreaterThanOrEqual(119)
    expect(edges(samples).trailMs).toBeLessThanOrEqual(121)
    expect(ms(stats.trailDropped)).toBeCloseTo(250, 0)
  })

  it('leaves a shorter trailing silence alone', () => {
    const { samples, stats } = run(join(tone(400), silence(80)))
    expect(edges(samples).trailMs).toBeGreaterThanOrEqual(79)
    expect(stats.trailDropped).toBe(0)
  })

  it('holds back only the quiet run: audio is forwarded live up to its start', () => {
    const trimmer = new EdgeTrimmer()
    const first = trimmer.push(samplesToBytes(tone(200)))
    expect(first).not.toBeNull()
    expect(ms(bytesToSamples(first!).length)).toBeGreaterThanOrEqual(190) // the tone went out at once (whole windows)
    expect(trimmer.push(samplesToBytes(silence(300)))).toBeNull() // the quiet run is held
    const end = trimmer.end()
    expect(ms(bytesToSamples(end!).length)).toBeCloseTo(120, 0) // and trimmed at the end
  })

  it('works with trailing decay below the threshold (a quiet tail that never reaches -40 dBFS)', () => {
    const { samples } = run(join(tone(300), hiss(500)))
    expect(edges(samples).trailMs).toBeLessThanOrEqual(121)
  })
})

describe('EdgeTrimmer: pauses inside the sentence', () => {
  it('does NOT cut a quiet run in the middle, however long', () => {
    for (const pause of [50, 200, 400, 900]) {
      const clip = join(silence(80), tone(300), silence(pause), tone(300), silence(300))
      const { samples } = run(clip)
      // lead-in 30 ms + 300 ms tone + the full pause + 300 ms tone + 120 ms tail
      expect(ms(samples.length)).toBeCloseTo(30 + 300 + pause + 300 + 120, -1)
    }
  })

  it('keeps the mid-sentence pause sample for sample (the held run is sent untouched, before the sound that ended it)', () => {
    const a = tone(200)
    const gap = silence(260)
    const b = tone(200, 9_000)
    const { samples } = run(join(silence(60), a, gap, b, silence(300)))
    const start = Math.round(edges(samples).leadMs * (SR / 1000))
    const body = samples.subarray(start, start + a.length + gap.length + b.length)
    expect(Array.from(body)).toEqual(Array.from(join(a, gap, b)))
  })

  it('a quiet hiss in the middle (below the threshold) is also kept: it is not an edge', () => {
    const { samples } = run(join(tone(200), hiss(300), tone(200), silence(200)))
    expect(ms(samples.length)).toBeCloseTo(200 + 300 + 200 + 120 + 30 * 0, -1)
  })

  it('never reorders or duplicates audio, whatever the chunk size', () => {
    const clip = join(silence(70), tone(130), silence(210), tone(90, 7_000), silence(333), tone(40, 3_000), silence(500))
    const reference = run(clip, 4_800).samples
    for (const chunk of [1, 7, 239, 240, 241, 500, 1_000, 5_000, 100_000]) {
      expect(Array.from(run(clip, chunk).samples), `chunk of ${chunk} samples`).toEqual(Array.from(reference))
    }
  })
})

describe('EdgeTrimmer: odd inputs', () => {
  it('a clip that is all silence produces no output at all', () => {
    const { samples, chunks, stats } = run(silence(800))
    expect(samples.length).toBe(0)
    expect(chunks).toHaveLength(0)
    expect(stats.sawSound).toBe(false)
    expect(stats.outSamples).toBe(0)
  })

  it('an empty stream produces no output', () => {
    expect(run(new Int16Array(0)).samples.length).toBe(0)
  })

  it('a clip with no silence at all comes through unchanged', () => {
    const voice = tone(250)
    const { samples, stats } = run(voice)
    expect(Array.from(samples)).toEqual(Array.from(voice))
    expect(stats.leadDropped + stats.trailDropped).toBe(0)
  })

  it('a clip shorter than one window (under 10 ms) that is loud survives', () => {
    const blip = tone(5)
    expect(Array.from(run(blip).samples)).toEqual(Array.from(blip))
  })

  it('a loud blip in the very last partial window is kept, and so is the silence before it', () => {
    const clip = join(tone(100), silence(200), tone(3))
    const { samples } = run(clip, 4_800)
    expect(ms(samples.length)).toBeCloseTo(100 + 200 + 3, -1)
  })

  it('always sends whole 16-bit samples (the byte count is even), whatever the sizes', () => {
    const clip = join(silence(33), tone(77), silence(55), tone(11), silence(400))
    for (const chunk of [1, 3, 241, 4_800]) {
      for (const bytes of run(clip, chunk).chunks) expect(bytes.length % 2).toBe(0)
    }
  })

  it('reports what it did, for the debug log', () => {
    const { stats } = run(join(silence(100), tone(200), silence(300)))
    expect(stats.inSamples).toBe(samplesFor(600))
    expect(stats.outSamples).toBe(stats.inSamples - stats.leadDropped - stats.trailDropped)
    expect(stats.sawSound).toBe(true)
    // the silence the clip really had at each edge, before any trimming (to the window the sound started in)
    expect(ms(stats.leadSilence)).toBeCloseTo(100, 0)
    expect(ms(stats.trailSilence)).toBeCloseTo(300, 0)
  })

  it('reports the real edge silences even when they are shorter than what is kept', () => {
    const { stats } = run(join(silence(20), tone(200), silence(60)))
    expect(ms(stats.leadSilence)).toBeCloseTo(20, 0)
    expect(ms(stats.trailSilence)).toBeCloseTo(60, 0)
    expect(stats.leadDropped + stats.trailDropped).toBe(0)
  })

  it('honours custom options', () => {
    const { samples } = run(join(silence(200), tone(100), silence(500)), 4_800, new EdgeTrimmer({ leadKeepMs: 50, trailMaxMs: 200 }))
    expect(edges(samples).leadMs).toBeGreaterThanOrEqual(49)
    expect(edges(samples).trailMs).toBeGreaterThanOrEqual(199)
    expect(edges(samples).trailMs).toBeLessThanOrEqual(201)
  })
})

describe('trimEdges (the streaming wrapper)', () => {
  async function* source(parts: Uint8Array[]) {
    for (const p of parts) yield p
  }
  it('trims a stream of chunks and yields them as they become safe', async () => {
    const clip = join(silence(100), tone(300), silence(400))
    const chunks: Uint8Array[] = []
    for (let i = 0; i < clip.length; i += 3_000) chunks.push(samplesToBytes(clip.subarray(i, i + 3_000)))
    const out: Uint8Array[] = []
    for await (const piece of trimEdges(source(chunks))) out.push(piece)
    const total = out.reduce((n, p) => n + p.length / 2, 0)
    expect(ms(total)).toBeCloseTo(30 + 300 + 120, -1)
    expect(out.every((p) => p.length % 2 === 0)).toBe(true)
  })
  it('yields nothing for an all-silent stream', async () => {
    const out: Uint8Array[] = []
    for await (const piece of trimEdges(source([samplesToBytes(silence(500))]))) out.push(piece)
    expect(out).toHaveLength(0)
  })
  it('does not swallow a source error', async () => {
    async function* broken() {
      yield samplesToBytes(tone(100))
      throw new Error('upstream dropped')
    }
    await expect((async () => { for await (const _ of trimEdges(broken())) void _ })()).rejects.toThrow('upstream dropped')
  })
})
