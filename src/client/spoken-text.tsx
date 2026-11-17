import { parseSpoken } from './format'

/**
 * Reply text for the feed. [Delivery tags] are small muted italics, {{display-only notes}} (pinyin) are small muted text after the
 * characters they explain. Neither is spoken (tags are performed by the voice, notes are skipped). Plain text wraps anywhere, so a
 * long URL or a run of Chinese never forces sideways scrolling.
 */
export function SpokenText({ text }: { text: string }) {
  return (
    <>
      {parseSpoken(text).map((part, i) =>
        part.kind === 'tag' ? (
          <em key={i} className="mx-0.5 text-[0.82em] italic text-zinc-500">
            {part.text}
          </em>
        ) : part.kind === 'note' ? (
          <span key={i} className="mx-1 text-[0.78em] tracking-wide text-zinc-500">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}
