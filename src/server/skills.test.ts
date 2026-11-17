import { describe, expect, it } from 'vitest'
import { SKILLS, collectSkills, parseSkill } from './skills'

const FILE = `---
name: demo-skill
description: Does a demo.
---
Step one.

Step two.
`

describe('parseSkill', () => {
  it('reads the frontmatter and the body', () => {
    expect(parseSkill(FILE)).toEqual({ name: 'demo-skill', description: 'Does a demo.', body: 'Step one.\n\nStep two.' })
  })
  it('accepts CRLF line endings, a BOM and quoted values', () => {
    const raw = '﻿---\r\nname: "quoted"\r\ndescription: \'It has: a colon\'\r\n---\r\nBody here.\r\n'
    expect(parseSkill(raw)).toEqual({ name: 'quoted', description: 'It has: a colon', body: 'Body here.' })
  })
  it('ignores unknown keys and blank frontmatter lines', () => {
    expect(parseSkill('---\nname: a\n\nauthor: me\ndescription: d\n---\nbody')).toEqual({ name: 'a', description: 'd', body: 'body' })
  })
  it('returns null for a file without frontmatter, a missing field, a bad name or an empty body', () => {
    expect(parseSkill('just text')).toBeNull()
    expect(parseSkill('---\nname: a\n---\nbody')).toBeNull()
    expect(parseSkill('---\ndescription: d\n---\nbody')).toBeNull()
    expect(parseSkill('---\nname: Bad Name\ndescription: d\n---\nbody')).toBeNull()
    expect(parseSkill('---\nname: a\ndescription: d\n---\n   \n')).toBeNull()
    expect(parseSkill('---\nname: a\ndescription: d\nbody without a closing fence')).toBeNull()
  })
})

describe('collectSkills', () => {
  it('sorts by name, skips broken files and keeps the first of a duplicate name', () => {
    const skills = collectSkills({
      '/skills/z.md': '---\nname: zebra\ndescription: z\n---\nz body',
      '/skills/a.md': '---\nname: apple\ndescription: first\n---\na body',
      '/skills/a2.md': '---\nname: apple\ndescription: second\n---\nother body',
      '/skills/broken.md': 'nope',
    })
    expect(skills.map((s) => [s.name, s.description])).toEqual([['apple', 'first'], ['zebra', 'z']])
  })
})

describe('the bundled skills', () => {
  it('include language-tutor and step-by-step, parsed from /skills/*.md', () => {
    expect(SKILLS.map((s) => s.name)).toEqual(['language-tutor', 'step-by-step'])
    for (const skill of SKILLS) {
      expect(skill.description.length).toBeGreaterThan(20)
      expect(skill.body.length).toBeGreaterThan(200)
      expect(skill.body.length).toBeLessThan(3000) // short enough to read into a spoken conversation
    }
  })
  it('keep pinyin-style notes inside {{ }}', () => {
    expect(SKILLS.find((s) => s.name === 'language-tutor')!.body).toContain('{{nǐ hǎo}}')
  })
})
