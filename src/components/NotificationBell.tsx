import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck, Settings } from 'lucide-react'
import {
  NOTIFICATIONS_CHANGED, leadPath, loadInbox, loadUnreadCount, markRead, notificationTitle, type InboxNotification,
} from '../lib/notifications'

const POLL_MS = 60_000

export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Header bell: unread count plus the latest notifications. Refreshes on an
// interval, when the window regains focus, and when a push arrives.
export default function NotificationBell() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<InboxNotification[] | null>(null)
  const [error, setError] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const refreshCount = useCallback(() => {
    loadUnreadCount().then(setUnread).catch(() => {})
  }, [])

  const refreshList = useCallback(() => {
    setError(false)
    loadInbox(15).then(setItems).catch(() => setError(true))
  }, [])

  useEffect(() => {
    refreshCount()
    const timer = window.setInterval(refreshCount, POLL_MS)
    const onChange = () => { refreshCount(); if (open) refreshList() }
    const onMessage = (e: MessageEvent) => { if (e.data?.type === 'notification-received') onChange() }
    window.addEventListener('focus', onChange)
    window.addEventListener(NOTIFICATIONS_CHANGED, onChange)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onChange)
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChange)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [refreshCount, refreshList, open])

  useEffect(() => {
    if (!open) return
    refreshList()
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, refreshList])

  const openItem = (n: InboxNotification) => {
    setOpen(false)
    if (!n.read_at) markRead([n.id]).catch(() => {})
    navigate(leadPath(n.lead_id))
  }

  const markAll = async () => {
    await markRead(null).catch(() => {})
    refreshList()
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative w-9 h-9 flex items-center justify-center rounded-lg text-slate-300 hover:text-white hover:bg-white/5 transition-colors"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell size={19} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-cobalt-500 text-[10px] font-bold text-white flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-2rem))] bg-obsidian-900 border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10">
            <p className="text-sm font-semibold text-white">Notifications</p>
            <div className="flex items-center gap-1">
              <button onClick={markAll} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white px-2 py-1 rounded-md hover:bg-white/5" disabled={unread === 0}>
                <CheckCheck size={13} /> Mark all read
              </button>
              <button onClick={() => { setOpen(false); navigate('/dashboard/notifications') }} className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/5" aria-label="Notification settings">
                <Settings size={14} />
              </button>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {error ? (
              <div className="px-3 py-6 text-center text-sm text-slate-400">
                Could not load notifications. <button onClick={refreshList} className="underline text-slate-200">Retry</button>
              </div>
            ) : items === null ? (
              <div className="p-3 space-y-2" aria-busy="true">
                {[0, 1, 2].map((i) => <div key={i} className="h-12 bg-white/5 rounded-lg animate-pulse" />)}
              </div>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">No notifications yet.</p>
            ) : (
              <ul>
                {items.map((n) => <NotificationRow key={n.id} n={n} onOpen={() => openItem(n)} />)}
              </ul>
            )}
          </div>
          <button onClick={() => { setOpen(false); navigate('/dashboard/notifications') }} className="w-full text-center text-xs font-medium text-cobalt-300 hover:text-cobalt-200 py-2.5 border-t border-white/10">
            View all and notification settings
          </button>
        </div>
      )}
    </div>
  )
}

export function NotificationRow({ n, onOpen }: { n: InboxNotification; onOpen: () => void }) {
  const subject = [n.lead?.customer_name, n.lead?.vehicle_name].filter(Boolean).join(' · ')
  return (
    <li>
      <button onClick={onOpen} className={`w-full text-left flex gap-2.5 px-3 py-2.5 border-b border-white/5 hover:bg-white/5 transition-colors ${n.read_at ? '' : 'bg-cobalt-500/5'}`}>
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${n.read_at ? 'bg-transparent' : 'bg-cobalt-400'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`text-sm truncate ${n.read_at ? 'text-slate-300' : 'font-semibold text-white'}`}>{notificationTitle(n)}</span>
            <span className="text-[11px] text-slate-500 flex-shrink-0">{timeAgo(n.created_at)}</span>
          </span>
          {subject && <span className="block text-xs text-slate-400 truncate">{subject}</span>}
          {!n.read_at && <span className="sr-only">Unread</span>}
        </span>
      </button>
    </li>
  )
}
