import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Bell, BellOff, CheckCheck, Mail, PlusSquare, Share, Smartphone, Trash2 } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import {
  NOTIFICATIONS_CHANGED, currentPushSupport, disablePushOnThisDevice, enablePushOnThisDevice, leadPath, loadDevices,
  loadInbox, markRead, removeDevice, subscriptionUsesCurrentKey, thisDeviceSubscription, type InboxNotification,
  type PushDevice,
} from '../lib/notifications'
import type { PushSupport } from '../lib/pushSupport'
import { NotificationRow } from '../components/NotificationBell'

const card = 'rounded-2xl border border-white/10 bg-obsidian-900/40 p-4 sm:p-5'
const primaryBtn = 'inline-flex items-center gap-2 text-sm font-semibold text-white bg-cobalt-600 hover:bg-cobalt-500 disabled:opacity-50 rounded-lg px-4 py-2 transition-colors'
const secondaryBtn = 'inline-flex items-center gap-2 text-sm font-medium text-slate-200 bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors'

export default function NotificationsPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [support, setSupport] = useState<PushSupport>(() => currentPushSupport())
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null)
  const [devices, setDevices] = useState<PushDevice[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [shopEmail, setShopEmail] = useState<string | null>(null)
  const [history, setHistory] = useState<InboxNotification[] | null>(null)
  const [historyError, setHistoryError] = useState(false)

  const refreshDevices = useCallback(async () => {
    setSupport(currentPushSupport())
    const [sub, list] = await Promise.all([
      thisDeviceSubscription().catch(() => null),
      loadDevices().catch(() => null),
    ])
    // A subscription made with rotated-out keys counts as off, so Enable
    // replaces it.
    setThisEndpoint(sub && subscriptionUsesCurrentKey(sub) ? sub.endpoint : null)
    setDevices(list)
  }, [])

  const refreshHistory = useCallback(() => {
    setHistoryError(false)
    loadInbox(100).then(setHistory).catch(() => setHistoryError(true))
  }, [])

  useEffect(() => {
    refreshDevices()
    refreshHistory()
    window.addEventListener(NOTIFICATIONS_CHANGED, refreshHistory)
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, refreshHistory)
  }, [refreshDevices, refreshHistory])

  useEffect(() => {
    if (!profile?.shop_id) return
    supabase.from('shops').select('contact_email').eq('id', profile.shop_id).maybeSingle()
      .then(({ data }) => setShopEmail(data?.contact_email ?? null))
  }, [profile?.shop_id])

  const enabledHere = support.state === 'granted' && !!thisEndpoint && !!devices?.some((d) => d.endpoint === thisEndpoint)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setPushError(null)
    try {
      await action()
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
      await refreshDevices()
    }
  }

  const openItem = (n: InboxNotification) => {
    if (!n.read_at) markRead([n.id]).catch(() => {})
    navigate(leadPath(n.lead_id))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Bell size={20} className="text-cobalt-400" /> Notifications</h1>
          <p className="text-sm text-slate-400 mt-0.5">New requests, customer messages, approvals, date selections and stage changes.</p>
        </div>

        <section className={card}>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Smartphone size={16} /> Push notifications on this device</h2>
          <p className="text-xs text-slate-400 mt-1">
            Alerts show a short, generic message on the lock screen — never customer details or message text. Tap one to open the lead.
            You won't be notified about your own actions.
          </p>

          <div className="mt-4">
            <PushStatus support={support} enabledHere={enabledHere} />
          </div>

          {pushError && (
            <p className="mt-3 flex items-start gap-2 text-sm text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <AlertCircle size={15} className="mt-0.5 flex-shrink-0" /> {pushError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {(support.state === 'ready' || support.state === 'granted') && !enabledHere && (
              <button className={primaryBtn} disabled={busy} onClick={() => run(enablePushOnThisDevice)}>
                <Bell size={15} /> {busy ? 'Enabling…' : 'Enable notifications'}
              </button>
            )}
            {enabledHere && (
              <button className={secondaryBtn} disabled={busy} onClick={() => run(disablePushOnThisDevice)}>
                <BellOff size={15} /> {busy ? 'Turning off…' : 'Turn off on this device'}
              </button>
            )}
          </div>

          {support.state === 'ios-install' && <IOSInstallSteps />}
        </section>

        <section className={card}>
          <h2 className="text-sm font-semibold text-white">Your devices</h2>
          <p className="text-xs text-slate-400 mt-1">Each phone, tablet or browser receives notifications separately. Signing out removes this device.</p>
          {devices === null ? (
            <p className="text-sm text-slate-500 mt-3">Could not load your devices.</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-slate-500 mt-3">No devices are receiving push notifications.</p>
          ) : (
            <ul className="mt-3 divide-y divide-white/5">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-100 truncate">
                      {d.user_agent || 'Device'}
                      {d.endpoint === thisEndpoint && <span className="ml-2 text-[11px] font-semibold text-cobalt-300">This device</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      Added {new Date(d.created_at).toLocaleDateString()}
                      {d.last_success_at ? ` · last notified ${new Date(d.last_success_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <button className={secondaryBtn} disabled={busy} onClick={() => run(() => removeDevice(d))} aria-label={`Remove ${d.user_agent || 'device'}`}>
                    <Trash2 size={14} /> Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card}>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Mail size={16} /> Email</h2>
          <p className="text-sm text-slate-300 mt-2">
            New requests and customer messages are emailed to your shop's contact email
            {shopEmail ? <> (<span className="text-white">{shopEmail}</span>)</> : ''}. When you reply to a customer on a quote, they get an email with a link back to their quote.
          </p>
        </section>

        <section className={card}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">History</h2>
            <button className={secondaryBtn} onClick={() => markRead(null).then(refreshHistory).catch(() => {})} disabled={!history?.some((n) => !n.read_at)}>
              <CheckCheck size={14} /> Mark all read
            </button>
          </div>
          {historyError ? (
            <p className="text-sm text-slate-400 mt-3">Could not load notifications. <button onClick={refreshHistory} className="underline text-slate-200">Retry</button></p>
          ) : history === null ? (
            <div className="mt-3 space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-12 bg-white/5 rounded-lg animate-pulse" />)}</div>
          ) : history.length === 0 ? (
            <p className="text-sm text-slate-500 mt-3">No notifications yet. New activity will appear here.</p>
          ) : (
            <ul className="mt-2 -mx-3">
              {history.map((n) => <NotificationRow key={n.id} n={n} onOpen={() => openItem(n)} />)}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function PushStatus({ support, enabledHere }: { support: PushSupport; enabledHere: boolean }) {
  const pill = (tone: 'good' | 'warn' | 'muted', label: string, detail: string) => (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
        tone === 'good' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
          : tone === 'warn' ? 'text-amber-200 border-amber-500/30 bg-amber-500/10'
            : 'text-slate-300 border-white/10 bg-white/5'
      }`}>{label}</span>
      <p className="text-sm text-slate-300">{detail}</p>
    </div>
  )
  if (enabledHere) return pill('good', 'On', 'This device will receive notifications.')
  switch (support.state) {
    case 'unsupported': return pill('muted', 'Unavailable', support.reason)
    case 'ios-install': return pill('warn', 'Install first', 'On iPhone and iPad, notifications work from the SpecPlus Home Screen app.')
    case 'blocked': return pill('warn', 'Blocked', 'Notifications are blocked for this site. Allow them in your browser or device settings, then reload this page.')
    case 'granted': return pill('muted', 'Off', 'Allowed by the browser, but this device is not receiving notifications. Turn them on below.')
    default: return pill('muted', 'Off', 'Turn on notifications to get alerts on this device.')
  }
}

function IOSInstallSteps() {
  return (
    <ol className="mt-4 space-y-2 text-sm text-slate-300 bg-white/5 border border-white/10 rounded-xl p-3">
      <li className="flex gap-2"><span className="text-cobalt-300 font-semibold">1.</span> Open this page in <strong className="text-white">Safari</strong> (iOS 16.4 or later).</li>
      <li className="flex gap-2"><span className="text-cobalt-300 font-semibold">2.</span> Tap <Share size={14} className="inline mt-0.5" aria-label="Share" /> <strong className="text-white">Share</strong>, then <PlusSquare size={14} className="inline mt-0.5" aria-hidden="true" /> <strong className="text-white">Add to Home Screen</strong>.</li>
      <li className="flex gap-2"><span className="text-cobalt-300 font-semibold">3.</span> Open <strong className="text-white">SpecPlus</strong> from your Home Screen and sign in.</li>
      <li className="flex gap-2"><span className="text-cobalt-300 font-semibold">4.</span> Go to Notifications and tap <strong className="text-white">Enable notifications</strong>, then <strong className="text-white">Allow</strong>.</li>
    </ol>
  )
}
