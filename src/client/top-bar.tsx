// The top bar: ☰ (chats) on the left, the chat's title in the middle, the Practice pill and "+" (new chat) on the right.
// It respects the iPhone notch, and every control is a 44 px touch target.

import type { Practice } from '../shared/api-types'
import { MenuIcon, PlusIcon } from './icons'
import { PracticePicker } from './practice-picker'

interface Props {
  title: string | null
  practice: Practice
  onPracticeChange: (value: Practice) => void
  onPracticeOpenChange: (open: boolean) => void
  onOpenDrawer: () => void
  onNewChat: () => void
  /** Dev preview only. */
  practiceOpenByDefault?: boolean
}

const iconButton =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/90 ' +
  'active:bg-white/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70'

export function TopBar({ title, practice, onPracticeChange, onPracticeOpenChange, onOpenDrawer, onNewChat, practiceOpenByDefault }: Props) {
  return (
    <header
      className="relative z-30 flex shrink-0 items-center gap-1 px-2"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingLeft: 'max(0.5rem, env(safe-area-inset-left, 0px))',
        paddingRight: 'max(0.5rem, env(safe-area-inset-right, 0px))',
      }}
    >
      <button type="button" aria-label="Chats" className={iconButton} onClick={onOpenDrawer}>
        <MenuIcon />
      </button>
      <p className="min-w-0 flex-1 truncate px-1 text-center text-[13px] text-white/35">{title ?? 'New chat'}</p>
      <PracticePicker
        value={practice}
        onChange={onPracticeChange}
        onOpenChange={onPracticeOpenChange}
        defaultOpen={practiceOpenByDefault}
      />
      <button type="button" aria-label="New chat" className={iconButton} onClick={onNewChat}>
        <PlusIcon />
      </button>
    </header>
  )
}
