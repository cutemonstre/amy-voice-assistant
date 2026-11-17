// The chat feed: your words right-aligned in a quiet dark-grey container, the assistant's replies left-aligned as plain text.
// It scrolls inside itself, stays pinned to the newest line while a reply streams in (only if you were already at the bottom),
// and pads its bottom by the dock's height, so nothing is ever drawn under the orb or its status line.

import { useLayoutEffect, useRef } from 'react'
import { domainOf } from '../shared/api-types'
import { formatMeta } from './format'
import { languageOfReply, type FeedItem, type ToolLine } from './feed-model'
import { SpokenText } from './spoken-text'

interface Props {
  items: FeedItem[]
  loading: boolean
  /** Changes when a different chat is opened: the feed jumps to its end. */
  resetKey: string | null
}

const NEAR_BOTTOM_PX = 72

export function Feed({ items, loading, resetKey }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true) // was the reader at the bottom? Then keep following new text.
  const countRef = useRef(0)
  const resetRef = useRef<string | null>(null)

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // A different chat, or the user's own new message: always go to the end. Streaming text: only if they are already there.
    const added = items.length > countRef.current
    if (resetRef.current !== resetKey) stickRef.current = true
    else if (added && items[items.length - 1]?.role === 'assistant' && items[items.length - 2]?.role === 'user') stickRef.current = true
    resetRef.current = resetKey
    countRef.current = items.length
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, resetKey])

  const empty = items.length === 0 && !loading

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="feed relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      style={{
        paddingBottom: 'calc(var(--dock-h) + 44px)', // the dock, plus the fade above it (see .feed in styles.css)
        paddingLeft: 'max(1rem, env(safe-area-inset-left, 0px))',
        paddingRight: 'max(1rem, env(safe-area-inset-right, 0px))',
      }}
    >
      {empty ? (
        <div className="flex h-full min-h-48 items-center justify-center">
          <p className="text-center text-[15px] text-white/30">Hold the orb and say something</p>
        </div>
      ) : (
        <ol className="wrap-any mx-auto flex w-full max-w-2xl flex-col gap-5 pb-2 pt-3">
          {items.map((item, index) =>
            item.role === 'user' ? (
              <li key={item.key} className="fade-in flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-800/90 px-3.5 py-2.5 text-[15px] leading-snug text-zinc-100">
                  {item.text || <span className="text-zinc-500">…</span>}
                </p>
              </li>
            ) : (
              <li key={item.key} className="fade-in max-w-[94%]">
                <ToolLines lines={item.tools} />
                {item.text ? (
                  <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-200">
                    <SpokenText text={item.text} />
                  </p>
                ) : (
                  item.live && (
                    <p className="typing py-1.5 text-zinc-400" role="status" aria-label="Thinking">
                      <span />
                      <span />
                      <span />
                    </p>
                  )
                )}
                {item.error && <p className="mt-1 text-xs text-red-300/75">{item.error}</p>}
                <Sources items={item.sources} />
                <Meta item={item} lang={languageOfReply(items, index)} />
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  )
}

/** The tiny line under a reply: `3.5 s · zh · Turbo`, and "interrupted" when it was cut off. It sits in the flow, never over the text. */
function Meta({ item, lang }: { item: FeedItem; lang: string | null }) {
  if (item.live) return null
  const meta = formatMeta({
    firstSoundMs: item.timing?.firstSound,
    ttsFirstMs: item.timing?.ttsFirst,
    llmFirstMs: item.timing?.llmFirst,
    lang,
    ttsModel: item.ttsModel,
    interrupted: item.interrupted,
  })
  return meta ? <p className="mt-1 text-[11px] text-zinc-500">{meta}</p> : null
}

/** What the model did besides talking, one small muted line each: "Searched the web", "Remembered: …", "Using skill: step-by-step". */
function ToolLines({ lines }: { lines: ToolLine[] | undefined }) {
  if (!lines?.length) return null
  return (
    <ul className="mb-1.5 space-y-0.5" aria-label="Actions">
      {lines.map((line) => (
        <li key={line.id} className="flex items-baseline gap-2 text-[12px] leading-snug text-zinc-500">
          <span
            aria-hidden="true"
            className={`relative top-[-1px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              line.status === 'start' ? 'tool-running bg-cyan-300/70' : line.status === 'error' ? 'bg-red-400/60' : 'bg-zinc-600'
            }`}
          />
          <span className="min-w-0">{line.label}</span>
        </li>
      ))}
    </ul>
  )
}

/** The pages a web-searched reply cited: up to 3 small links, by domain name, opening in a new tab. Only http(s) links are drawn. */
function Sources({ items }: { items: FeedItem['sources'] }) {
  const links = (items ?? []).filter((s) => /^https?:\/\//i.test(s.url)).slice(0, 3)
  if (!links.length) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1" aria-label="Sources">
      {links.map((source) => {
        const domain = domainOf(source.url)
        return (
          <li key={source.url} className="min-w-0">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={source.title}
              aria-label={`${source.title} (${domain}), opens in a new tab`}
              // The pill is small; the invisible ::after pads the tap area out to 44 px or more.
              className="relative block max-w-[11rem] truncate rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] leading-4 text-zinc-400 after:absolute after:-inset-2.5 after:content-[''] hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
            >
              {domain}
            </a>
          </li>
        )
      })}
    </ul>
  )
}
