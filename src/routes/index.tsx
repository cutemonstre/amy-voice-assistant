import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Drawer, type DrawerTab } from '@/client/drawer'
import { Feed } from '@/client/feed'
import { titleOf, type FeedItem } from '@/client/feed-model'
import { OrbDock, type Visual } from '@/client/orb'
import { TopBar } from '@/client/top-bar'
import { useVoiceChat } from '@/client/use-voice-chat'

export const Route = createFileRoute('/')({ component: Home })

const STATUS: Record<Visual, string> = {
  idle: 'Hold to talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Tap to interrupt',
  error: 'Hold to talk',
}
const VISUALS: Visual[] = ['idle', 'listening', 'thinking', 'speaking', 'error']
const ERROR_FLASH_MS = 1600

// ---- dev-only preview (compiled out of production builds) -----------------------------------------------------------------------
// /?state=idle|listening|thinking|speaking|error pins the orb (with a fake sound level) so every state can be looked at without a
// microphone. &demo=1 fills the feed with sample messages. &drawer=1 and &practice=1 open the drawer and the Practice menu,
// and &tab=memories opens the drawer on its Memories tab.
const DEMO_ITEMS: FeedItem[] = import.meta.env.DEV
  ? [
      { key: 'd0', role: 'user', text: 'Who won the most recent Formula 1 race?', lang: 'eng' },
      {
        key: 'd0a', role: 'assistant', ttsModel: 'eleven_v4_turbo',
        text: "Let me check. [excited] Max Verstappen won yesterday's Bahrain Grand Prix, held in Sepang, Malaysia. It was his first win of the 2026 season. Kimi Antonelli was second and Lewis Hamilton third.",
        tools: [{ id: 'web_search', name: 'web_search', status: 'done', label: 'Searched the web' }],
        sources: [
          { title: 'Formula One: Verstappen clinches Bahrain GP in first win of 2026', url: 'https://aljazeera.com/sports/2026/10/4/red-bulls-verstappen-wins' },
          { title: 'Bahrain GP in Malaysia: Max Verstappen wins first race of 2026', url: 'https://www.skysports.com/f1/news/13594860/bahrain-gp' },
          { title: 'Verstappen wins in Sepang', url: 'https://www.bbc.co.uk/sport/formula1/articles/c1' },
        ],
        timing: { stt: 903, llmFirst: 2962, ttsFirst: 3580, firstSound: 4100 },
      },
      { key: 'd0b', role: 'user', text: "Remember that I'm learning Mandarin.", lang: 'eng' },
      {
        key: 'd0c', role: 'assistant', ttsModel: 'eleven_v4_turbo',
        text: "Got it, I'll remember that. Want to practice a bit now?",
        tools: [{ id: 't1', name: 'remember', status: 'done', label: 'Remembered: The user is learning Mandarin.' }],
        timing: { stt: 585, llmFirst: 4264, ttsFirst: 4393, firstSound: 4700 },
      },
      { key: 'd0d', role: 'user', text: 'Walk me through making a cup of tea, step by step.', lang: 'eng' },
      {
        key: 'd0e', role: 'assistant', ttsModel: 'eleven_v4_turbo',
        text: "It's five steps and takes about five minutes. You'll need a mug, a tea bag, water and a kettle. Step one: fill the kettle with about a cup of water and switch it on. Tell me when that's done.",
        tools: [{ id: 't2', name: 'load_skill', status: 'done', label: 'Using skill: step-by-step' }],
        timing: { stt: 989, llmFirst: 4424, ttsFirst: 4564, firstSound: 5000 },
      },
      { key: 'd1', role: 'user', text: "What's one fun fact about octopuses?", lang: 'eng' },
      {
        key: 'd2', role: 'assistant', ttsModel: 'eleven_v4_turbo',
        text: '[excited] Octopuses have three hearts and blue blood! Two hearts pump blood to the gills, and the third sends it to the rest of the body.',
        timing: { stt: 596, llmFirst: 1540, ttsFirst: 2400, firstSound: 3500 },
      },
      { key: 'd3', role: 'user', text: '你好，我想喝咖啡。', lang: 'zho' },
      {
        key: 'd4', role: 'assistant', ttsModel: 'eleven_v4_turbo',
        text: '你说得很对！你好，我想喝咖啡。{{nǐ hǎo, wǒ xiǎng hē kāfēi}} [warmly] Your sentence was perfect, and the tones sounded natural. 你喜欢喝热咖啡，还是冰咖啡？{{nǐ xǐhuan hē rè kāfēi, háishi bīng kāfēi}}',
        timing: { stt: 870, llmFirst: 2024, ttsFirst: 2507, firstSound: 3200 },
      },
      { key: 'd5', role: 'user', text: 'How do I say "I would like a cup of tea, please"? https://example.com/a-very-long-link-that-should-wrap-instead-of-scrolling-sideways-on-a-phone', lang: 'eng' },
      {
        key: 'd6', role: 'assistant', ttsModel: 'eleven_v4', interrupted: true,
        text: '[softly] 我想要一杯茶，谢谢。{{wǒ xiǎng yào yì bēi chá, xièxie}} Say it slowly: 我想要…',
        timing: { llmFirst: 1700, ttsFirst: 2600 },
      },
    ]
  : []

function useDevPreview() {
  const [preview, setPreview] = useState<{ state: Visual | null; demo: boolean; drawer: boolean; practice: boolean; tab: DrawerTab | undefined }>({
    state: null,
    demo: false,
    drawer: false,
    practice: false,
    tab: undefined,
  })
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const q = new URLSearchParams(window.location.search)
    const wanted = q.get('state')
    setPreview({
      state: wanted && (VISUALS as string[]).includes(wanted) ? (wanted as Visual) : null,
      demo: q.has('demo'),
      drawer: q.has('drawer'),
      practice: q.has('practice'),
      tab: q.get('tab') === 'memories' ? 'memories' : undefined,
    })
  }, [])
  return preview
}

function Home() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [practiceOpen, setPracticeOpen] = useState(false)
  const [sessionsVersion, setSessionsVersion] = useState(0)
  const [flash, setFlash] = useState(false)
  const preview = useDevPreview()

  // The Space bar talks, except while the drawer or the Practice menu is open (there it works the focused control).
  const chat = useVoiceChat({ spaceEnabled: !drawerOpen && !practiceOpen })

  useEffect(() => {
    if (preview.drawer) setDrawerOpen(true)
  }, [preview.drawer])

  // An error tints the orb red for a moment, then it settles back to the real state.
  useEffect(() => {
    if (chat.errorTick === 0) return
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), ERROR_FLASH_MS)
    return () => clearTimeout(timer)
  }, [chat.errorTick])

  // After a turn ends the saved chat list has changed: have the drawer reload it next time it opens.
  useEffect(() => {
    if (chat.phase === 'idle') setSessionsVersion((v) => v + 1)
  }, [chat.phase])

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const forced = preview.state
  const visual: Visual = forced ?? (flash ? 'error' : chat.phase)
  const items = preview.demo ? DEMO_ITEMS : chat.items
  const status = STATUS[visual]

  return (
    <main className="relative flex h-dvh w-full flex-col overflow-hidden">
      <TopBar
        title={titleOf(items)}
        practice={chat.practice}
        onPracticeChange={chat.setPractice}
        onPracticeOpenChange={setPracticeOpen}
        practiceOpenByDefault={preview.practice}
        onOpenDrawer={() => setDrawerOpen(true)}
        onNewChat={chat.newChat}
      />

      {/* notices sit IN the layout (between the top bar and the feed), so they push the feed down instead of covering it */}
      {(chat.locked || chat.notices.length > 0) && (
        <div className="relative z-20 flex shrink-0 flex-col items-center gap-1.5 px-4 pb-2 pt-1">
          {chat.locked && (
            <p role="alert" className="rounded-full bg-amber-300/10 px-3.5 py-1.5 text-center text-xs text-amber-100/75">
              Locked. Open your private link.
            </p>
          )}
          {chat.notices.map((n) => (
            <p
              key={n.id}
              role={n.kind === 'error' ? 'alert' : 'status'}
              className={`flex max-w-md items-start gap-2 rounded-2xl bg-white/[0.05] px-3.5 py-1.5 text-xs leading-snug ${
                n.kind === 'error' ? 'text-red-200/80' : n.kind === 'warn' ? 'text-amber-100/65' : 'text-white/55'
              }`}
            >
              <span className="wrap-any min-w-0">{n.text}</span>
              <button
                type="button"
                aria-label="Dismiss"
                className="-my-3 -mr-3 flex h-11 w-11 shrink-0 items-center justify-center text-base text-white/45 hover:text-white/80"
                onClick={() => chat.dismissNotice(n.id)}
              >
                ×
              </button>
            </p>
          ))}
        </div>
      )}

      <Feed items={items} loading={chat.loadingSession && !preview.demo} resetKey={chat.sessionId} />

      <OrbDock
        visual={visual}
        status={status}
        pressed={chat.phase === 'listening'}
        getAnalyser={chat.getAnalyser}
        synthetic={forced !== null}
        onPress={() => chat.press('pointer')}
        onRelease={() => void chat.release('pointer')}
      />

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        currentId={chat.sessionId}
        refreshKey={sessionsVersion}
        ttsModel={chat.ttsModel}
        onTtsModel={chat.setTtsModel}
        pace={chat.pace}
        onPace={chat.setPace}
        onOpenSession={chat.openSession}
        onDeleted={chat.sessionDeleted}
        onLocked={chat.markLocked}
        initialTab={preview.tab}
      />
    </main>
  )
}
