import { describe, expect, it } from 'vitest'
import { MAX_SENTENCE_CHARS, STALL_MS, createNoteStripper, createSentenceSplitter, createSpacer } from './sentences'

/** Feed `text` in small pieces (like LLM tokens) and collect everything, including the flushed tail. */
function split(text: string, piece = 3): string[] {
  const splitter = createSentenceSplitter()
  const out: string[] = []
  for (let i = 0; i < text.length; i += piece) out.push(...splitter.push(text.slice(i, i + piece)))
  const tail = splitter.flush()
  if (tail) out.push(tail)
  return out
}

describe('sentence splitter', () => {
  it('splits normal sentences at . ! ? followed by whitespace', () => {
    expect(split('Hello there. How are you? I am great! Thanks.')).toEqual(['Hello there.', 'How are you?', 'I am great!', 'Thanks.'])
  })

  it('gives the same result however the text is chunked', () => {
    const text = 'One fish. Two fish? Red fish! Blue fish.'
    const expected = ['One fish.', 'Two fish?', 'Red fish!', 'Blue fish.']
    for (const piece of [1, 2, 3, 7, 100]) expect(split(text, piece)).toEqual(expected)
  })

  it('holds a trailing terminator back until the next character, and flush() releases it', () => {
    const splitter = createSentenceSplitter()
    expect(splitter.push('Hello there.')).toEqual([])
    expect(splitter.push(' How')).toEqual(['Hello there.'])
    expect(splitter.flush()).toBe('How')
    expect(splitter.flush()).toBeNull()
  })

  it('keeps closing quotes and brackets with the sentence', () => {
    expect(split('She said "stop." Then she left (quietly.) Done.')).toEqual(['She said "stop."', 'Then she left (quietly.)', 'Done.'])
  })

  it('does not split after common abbreviations', () => {
    expect(split('Dr. Smith met Mr. Jones and Mrs. Lee at St. Paul. They talked.')).toEqual([
      'Dr. Smith met Mr. Jones and Mrs. Lee at St. Paul.',
      'They talked.',
    ])
    expect(split('It is cats vs. dogs, e.g. big ones, i.e. loud ones, etc. Fine.')).toEqual([
      'It is cats vs. dogs, e.g. big ones, i.e. loud ones, etc. Fine.',
    ])
  })

  it('does not split after single-letter initials or dotted initialisms', () => {
    expect(split('J. K. Rowling wrote it. Good book.')).toEqual(['J. K. Rowling wrote it.', 'Good book.'])
    expect(split('He moved to the U.S. last year. Nice.')).toEqual(['He moved to the U.S. last year.', 'Nice.'])
  })

  it('still splits after the pronoun I', () => {
    expect(split('So do I. Really.')).toEqual(['So do I.', 'Really.'])
  })

  it('does not split decimals like 3.5 or version numbers', () => {
    expect(split('The ratio is 3.5 to 1. Version 2.0.1 is out.')).toEqual(['The ratio is 3.5 to 1.', 'Version 2.0.1 is out.'])
  })

  it('does not treat a list number as a sentence', () => {
    expect(split('1. Apples\n2. Pears')).toEqual(['1. Apples', '2. Pears'])
  })

  it('splits at an ellipsis followed by whitespace, as one run', () => {
    expect(split('Hmm… let me think. Well... maybe so.')).toEqual(['Hmm…', 'let me think.', 'Well...', 'maybe so.'])
  })

  it('splits at newlines even without a terminator', () => {
    expect(split('First line\nSecond line\n\nThird')).toEqual(['First line', 'Second line', 'Third'])
  })

  it('splits on ?! runs', () => {
    expect(split('Really?! Yes.')).toEqual(['Really?!', 'Yes.'])
  })

  it('forces a split at the last comma once a run-on passes the limit', () => {
    const clause = 'and then we walked a little further down the road, '
    const runOn = clause.repeat(8).trim() // no terminator, ~400 chars
    const splitter = createSentenceSplitter()
    const out = splitter.push(runOn)
    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS)
      expect(s.endsWith(',')).toBe(true)
    }
    expect([...out, splitter.flush()].join(' ')).toBe(runOn)
  })

  it('forces a split at the last space when there is no usable comma', () => {
    const runOn = 'word '.repeat(80).trim() // 399 chars, no punctuation
    const splitter = createSentenceSplitter()
    const out = splitter.push(runOn)
    expect(out.length).toBeGreaterThanOrEqual(1)
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS)
      expect(s.startsWith('word')).toBe(true)
      expect(s.endsWith('word')).toBe(true)
    }
    expect([...out, splitter.flush()].join(' ')).toBe(runOn)
  })

  it('forces a split even for one huge token with no spaces', () => {
    const splitter = createSentenceSplitter()
    const out = splitter.push('a'.repeat(500))
    expect(out.every((s) => s.length <= MAX_SENTENCE_CHARS)).toBe(true)
    expect(out.join('') + (splitter.flush() ?? '')).toBe('a'.repeat(500))
  })

  it('strips markdown symbols', () => {
    expect(split('**Great** question! Use `npm install` for _that_. # Done')).toEqual(['Great question!', 'Use npm install for that.', 'Done'])
    expect(split('This is **bold.** Next one.')).toEqual(['This is bold.', 'Next one.'])
  })

  it('drops pieces with nothing speakable in them', () => {
    expect(split('Hello.\n\n...\n---\nBye.')).toEqual(['Hello.', 'Bye.'])
  })

  it('flush() returns the unfinished tail once, then null', () => {
    const splitter = createSentenceSplitter()
    expect(splitter.push('This has no end')).toEqual([])
    expect(splitter.flush()).toBe('This has no end')
    expect(splitter.flush()).toBeNull()
  })

  it('flush() on an empty or whitespace-only buffer is null', () => {
    const splitter = createSentenceSplitter()
    expect(splitter.flush()).toBeNull()
    splitter.push('  \n ')
    expect(splitter.flush()).toBeNull()
  })

  describe('Eleven v4 audio tags', () => {
    it('keeps square-bracket tags attached to their sentence', () => {
      expect(split('[excited] Octopuses have three hearts! [laughs] That is wild.')).toEqual([
        '[excited] Octopuses have three hearts!',
        '[laughs] That is wild.',
      ])
    })

    it('does not strip brackets but still strips markdown', () => {
      expect(split('**[whispers] Hey** there. Use `[softly]` too.')).toEqual(['[whispers] Hey there.', 'Use [softly] too.'])
    })

    it('handles a tag split across deltas', () => {
      const splitter = createSentenceSplitter()
      expect(splitter.push('Nice one! [lau')).toEqual([])
      expect(splitter.push('ghs] Really')).toEqual(['Nice one!'])
      expect(splitter.flush()).toBe('[laughs] Really')
    })

    it('merges a lone tag piece into the NEXT sentence mid-reply', () => {
      expect(split("That's funny.\n[laughs]\nI love it.")).toEqual(["That's funny.", '[laughs] I love it.'])
      expect(split("That's funny. [laughs]. I love it.")).toEqual(["That's funny.", '[laughs]. I love it.'])
    })

    it('merges a trailing lone tag into the PREVIOUS sentence at the end of the reply', () => {
      const splitter = createSentenceSplitter()
      expect(splitter.push("That's funny. [laughs]")).toEqual([]) // held: the tag might be alone
      expect(splitter.flush()).toBe("That's funny. [laughs]")
      expect(split("That's funny. [laughs]")).toEqual(["That's funny. [laughs]"])
      expect(split("First one. That's funny. [laughs]", 1)).toEqual(['First one.', "That's funny. [laughs]"])
    })

    it('merges stacked trailing tags and tags after a newline', () => {
      expect(split('Oh no.\n[sighs] [softly]')).toEqual(['Oh no. [sighs] [softly]'])
    })

    it('flushes a reply that is only a tag', () => {
      expect(split('[laughs]')).toEqual(['[laughs]'])
    })

    it('releases a held sentence as soon as words follow the tag', () => {
      const splitter = createSentenceSplitter()
      expect(splitter.push('Hello there. [soft')).toEqual([])
      expect(splitter.push('ly] Are you ok')).toEqual(['Hello there.'])
      expect(splitter.flush()).toBe('[softly] Are you ok')
    })

    it('gives the same result however tagged text is chunked', () => {
      const text = "[curious] Really? [laughs] Okay, that's fun.\n[sighs]\nBack to it. [whispers]"
      const expected = split(text, 1000)
      for (const piece of [1, 2, 3, 5, 8]) expect(split(text, piece)).toEqual(expected)
      expect(expected).toEqual(['[curious] Really?', "[laughs] Okay, that's fun.", '[sighs] Back to it. [whispers]'])
    })
  })

  describe('display-only {{notes}}', () => {
    it('strips a note from the spoken sentence', () => {
      expect(split('你好{{nǐ hǎo}}！很高兴认识你{{hěn gāoxìng rènshi nǐ}}。')).toEqual(['你好！', '很高兴认识你。'])
    })

    it('strips a note that arrives split across deltas, at every possible split point', () => {
      const text = 'Say 你好{{nǐ hǎo}} to her. Then 谢谢{{xièxie}}.'
      const expected = split(text, 1000)
      expect(expected).toEqual(['Say 你好 to her.', 'Then 谢谢.'])
      for (const piece of [1, 2, 3, 4, 5, 7]) expect(split(text, piece)).toEqual(expected)
    })

    it('never leaks half a note while it streams', () => {
      const splitter = createSentenceSplitter()
      expect(splitter.push('你好{{nǐ')).toEqual([])
      expect(splitter.push(' hǎo}')).toEqual([])
      expect(splitter.push('}。再见')).toEqual(['你好。'])
      expect(splitter.flush()).toBe('再见')
    })

    it('does not treat a terminator inside a note as a sentence end', () => {
      expect(split('Fine {{a. b? c!}} then. Done.')).toEqual(['Fine then.', 'Done.'])
    })

    it('closes the gap a note leaves before punctuation', () => {
      expect(split('Hello {{hə-ˈloʊ}}. Next one.')).toEqual(['Hello.', 'Next one.'])
    })

    it('drops a piece that was only a note', () => {
      expect(split('Hi.\n{{only a note}}\nBye.')).toEqual(['Hi.', 'Bye.'])
    })

    it('drops an unfinished note at the end of the reply', () => {
      expect(split('你好{{nǐ hǎo')).toEqual(['你好'])
    })

    it('leaves single braces alone', () => {
      expect(split('Use {braces} sometimes. And } or { alone.')).toEqual(['Use {braces} sometimes.', 'And } or { alone.'])
    })

    it('keeps tags and strips notes together', () => {
      expect(split('[softly] 你好{{nǐ hǎo}}！[laughs] 加油{{jiāyóu}}！')).toEqual(['[softly] 你好！', '[laughs] 加油！'])
    })
  })

  describe('Mandarin (full-width punctuation)', () => {
    it('splits at 。！？ with no space after them', () => {
      expect(split('你好！你叫什么名字？我叫小明。很高兴认识你。')).toEqual(['你好！', '你叫什么名字？', '我叫小明。', '很高兴认识你。'])
    })

    it('keeps closing quotes with the sentence', () => {
      expect(split('他说「你好。」然后走了。')).toEqual(['他说「你好。」', '然后走了。'])
    })

    it('splits mixed English and Chinese', () => {
      expect(split('You say it like this. 你好吗？Try it now.')).toEqual(['You say it like this.', '你好吗？', 'Try it now.'])
    })

    it('forces a split at a Chinese comma in a very long unpunctuated stretch', () => {
      const runOn = '我们今天一起去公园玩，'.repeat(30).replace(/，$/, '')
      const splitter = createSentenceSplitter()
      const out = splitter.push(runOn)
      expect(out.length).toBeGreaterThanOrEqual(1)
      for (const s of out) {
        expect(s.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS)
        expect(s.endsWith('，')).toBe(true)
      }
    })
  })
})

describe('createNoteStripper', () => {
  it('removes notes across pushes and keeps everything else byte for byte', () => {
    const stripper = createNoteStripper()
    const out = ['a {{x', 'y}} b', ' {{z}', '} c {d} e'].map((p) => stripper.push(p)).join('') + stripper.flush()
    expect(out).toBe('a  b  c {d} e')
  })

  it('holds a lone "{" back until it is known not to start a note, then releases it', () => {
    const stripper = createNoteStripper()
    expect(stripper.push('x {')).toBe('x ')
    expect(stripper.push('y')).toBe('{y')
    expect(stripper.push('end {')).toBe('end ')
    expect(stripper.flush()).toBe('{')
  })
})


describe('stall flush (decision 28)', () => {
  it('releases a sentence that ends the buffer, so "Let me check." can be spoken while the search runs', () => {
    const splitter = createSentenceSplitter()
    expect(splitter.push('Let me check.')).toEqual([]) // the "." may still become "3.5": held back
    expect(splitter.stall()).toBe('Let me check.')
    expect(splitter.stall()).toBeNull() // nothing left
    expect(splitter.flush()).toBeNull()
  })

  it('works for ! ? and … too, and keeps closing quotes with the sentence', () => {
    for (const [text, expected] of [['One moment!', 'One moment!'], ['Hold on?', 'Hold on?'], ['Hmm…', 'Hmm…'], ['She said "wait."', 'She said "wait."'], ['Okay (sure.)', 'Okay (sure.)']] as const) {
      const splitter = createSentenceSplitter()
      splitter.push(text)
      expect(splitter.stall(), text).toBe(expected)
    }
  })

  it('releases a sentence whose trailing whitespace or newline is the last thing that arrived', () => {
    const splitter = createSentenceSplitter()
    expect(splitter.push('Let me check.\n\n')).toEqual([]) // held while a lone tag might still follow
    expect(splitter.stall()).toBe('Let me check.')
  })

  it('does not release a buffer that does not end at a sentence end', () => {
    const splitter = createSentenceSplitter()
    splitter.push('Let me check')
    expect(splitter.stall()).toBeNull()
    splitter.push(' the')
    expect(splitter.stall()).toBeNull()
    expect(splitter.flush()).toBe('Let me check the')
  })

  it('does not release a "." that may belong to a number or an abbreviation', () => {
    for (const text of ['It is version 3.', 'The ratio is 3.', 'I saw Dr.', 'Call Mr.', 'It costs e.g.', 'J.']) {
      const splitter = createSentenceSplitter()
      splitter.push(text)
      expect(splitter.stall(), text).toBeNull()
    }
  })

  it('releases an ellipsis made of dots', () => {
    const splitter = createSentenceSplitter()
    splitter.push('Well...')
    expect(splitter.stall()).toBe('Well...')
  })

  it('only releases the unfinished sentence: earlier ones were already emitted by push', () => {
    const splitter = createSentenceSplitter()
    expect(splitter.push('Sure thing. Let me check.')).toEqual(['Sure thing.'])
    expect(splitter.stall()).toBe('Let me check.')
  })

  it('strips markdown and display-only notes from the released sentence, and keeps a half-arrived note out of it', () => {
    const splitter = createSentenceSplitter()
    splitter.push('**Okay**, 好的{{hǎo de}}。') // held back: a lone tag might still follow
    expect(splitter.stall()).toBe('Okay, 好的。')
    const s2 = createSentenceSplitter()
    expect(s2.push('One moment.{{par')).toEqual([])
    expect(s2.stall()).toBe('One moment.')
    expect(s2.push('tial}} Next.')).toEqual([]) // the rest of the note is still swallowed
    expect(s2.flush()).toBe('Next.')
  })

  it('carries a lone tag forward instead of releasing it alone', () => {
    const splitter = createSentenceSplitter()
    splitter.push('[softly].')
    expect(splitter.stall()).toBeNull()
    expect(splitter.push(' Hello there.')).toEqual([])
    expect(splitter.stall()).toBe('[softly]. Hello there.')
  })

  it('is exported with a 250 ms threshold', () => {
    expect(STALL_MS).toBe(250)
  })
})

describe('createSpacer: "check.Max" and friends', () => {
  it('puts a space in when text resumes with none after a stall flush', () => {
    const spacer = createSpacer()
    expect(spacer.fix('Let me check.')).toBe('Let me check.')
    spacer.boundary() // the stall flush fired
    expect(spacer.fix('Max Verstappen won.')).toBe(' Max Verstappen won.')
  })

  it('does the same after the end of an LLM round', () => {
    const spacer = createSpacer()
    spacer.fix("Got it, I'll remember that")
    spacer.boundary()
    expect(spacer.fix('Anything else?')).toBe(' Anything else?')
  })

  it('adds nothing when whitespace is already there, on either side', () => {
    const a = createSpacer()
    a.fix('Let me check. ')
    a.boundary()
    expect(a.fix('Max won.')).toBe('Max won.')
    const b = createSpacer()
    b.fix('Let me check.')
    b.boundary()
    expect(b.fix(' Max won.')).toBe(' Max won.')
    const c = createSpacer()
    c.fix('Let me check.\n')
    c.boundary()
    expect(c.fix('Max won.')).toBe('Max won.')
  })

  it('does nothing without a boundary (the model\'s own tokens are left alone)', () => {
    const spacer = createSpacer()
    spacer.fix('Hello')
    expect(spacer.fix('world')).toBe('world')
    expect(spacer.fix('!')).toBe('!')
  })

  it('does nothing at the very start of the reply', () => {
    const spacer = createSpacer()
    spacer.boundary()
    expect(spacer.fix('Hello')).toBe('Hello')
  })

  it('applies a boundary once, to the next non-empty delta only', () => {
    const spacer = createSpacer()
    spacer.fix('Let me check.')
    spacer.boundary()
    expect(spacer.fix('')).toBe('')
    expect(spacer.fix('Max')).toBe(' Max')
    expect(spacer.fix('imilian')).toBe('imilian')
  })

  it('a citation (soft boundary) only adds a space after a sentence end, so it can never split a word', () => {
    const afterSentence = createSpacer()
    afterSentence.fix('He won the race.')
    afterSentence.boundary(true)
    expect(afterSentence.fix('Kimi came second.')).toBe(' Kimi came second.')
    const midWord = createSpacer()
    midWord.fix('Verstap')
    midWord.boundary(true)
    expect(midWord.fix('pen won.')).toBe('pen won.')
  })

  it('a hard boundary beats a soft one', () => {
    const spacer = createSpacer()
    spacer.fix('Hello')
    spacer.boundary(true)
    spacer.boundary()
    expect(spacer.fix('world')).toBe(' world')
  })

  it('leaves Chinese text alone: no space after a full-width stop or before a Chinese character', () => {
    const a = createSpacer()
    a.fix('你好。')
    a.boundary()
    expect(a.fix('再见')).toBe('再见')
    const b = createSpacer()
    b.fix('Say it:')
    b.boundary()
    expect(b.fix('你好')).toBe('你好')
  })

  it('feeds the splitter a clean sentence boundary, so the voice, the screen and the database all agree', () => {
    const spacer = createSpacer()
    const splitter = createSentenceSplitter()
    const spoken: string[] = []
    let shown = ''
    const feed = (delta: string) => {
      const fixed = spacer.fix(delta)
      shown += fixed
      spoken.push(...splitter.push(fixed))
    }
    feed('Let me check.')
    const stalled = splitter.stall()
    if (stalled) {
      spoken.push(stalled)
      spacer.boundary()
    }
    feed('Max Verstappen won the race.')
    feed(' Kimi was second.')
    const tail = splitter.flush()
    if (tail) spoken.push(tail)
    expect(spoken).toEqual(['Let me check.', 'Max Verstappen won the race.', 'Kimi was second.'])
    expect(shown).toBe('Let me check. Max Verstappen won the race. Kimi was second.')
  })
})
