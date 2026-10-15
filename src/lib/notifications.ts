import { supabase, getWorkflowMeta, workflowStatusFor } from './supabase'
import {
  LEAD_PATH_RE, base64UrlToUint8Array, deviceLabel, detectPushSupport, isIOSDevice, uint8ArrayToBase64Url,
  type PushSupport,
} from './pushSupport'

export type NotificationKind =
  | 'new_request' | 'customer_message' | 'quote_approved' | 'quote_declined' | 'date_requested' | 'status_changed'

export type InboxNotification = {
  id: string
  kind: NotificationKind | (string & {})
  metadata: { to?: string }
  lead_id: string
  created_at: string
  read_at: string | null
  lead: { customer_name: string | null; vehicle_name: string | null } | null
}

export type PushDevice = {
  id: string
  endpoint: string
  user_agent: string | null
  created_at: string
  last_seen_at: string
  last_success_at: string | null
}

// Unread changes from other parts of the app (bell ↔ notifications page).
export const NOTIFICATIONS_CHANGED = 'specplus:notifications-changed'
export const notifyInboxChanged = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

export function notificationTitle(n: Pick<InboxNotification, 'kind' | 'metadata'>): string {
  switch (n.kind) {
    case 'new_request': return 'New request'
    case 'customer_message': return 'New customer message'
    case 'quote_approved': return 'Quote approved'
    case 'quote_declined': return 'Quote declined'
    case 'date_requested': return 'Production date selected'
    case 'status_changed':
      return n.metadata?.to ? `Moved to ${getWorkflowMeta(workflowStatusFor(n.metadata.to)).label}` : 'Lead updated'
    default: return 'Lead update'
  }
}

export const leadPath = (leadId: string) => `/dashboard/leads/${leadId}`

const INBOX_FIELDS = 'id, kind, metadata, lead_id, created_at, read_at, lead:leads(customer_name, vehicle_name)'

export async function loadInbox(limit = 30): Promise<InboxNotification[]> {
  const { data, error } = await supabase.from('notifications').select(INBOX_FIELDS)
    .order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as InboxNotification[]
}

export async function loadUnreadCount(): Promise<number> {
  const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
  if (error) throw new Error(error.message)
  return count ?? 0
}

export async function markRead(ids: string[] | null): Promise<void> {
  const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids })
  if (error) throw new Error(error.message)
  notifyInboxChanged()
}

// ---------------------------------------------------------------------------
// Web Push on this device
// ---------------------------------------------------------------------------

const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim() ?? ''
const WORKER_URL = '/push-sw.js'

export function currentPushSupport(): PushSupport {
  const nav = navigator as Navigator & { standalone?: boolean }
  return detectPushSupport({
    isSecureContext: window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : null,
    isIOS: isIOSDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0),
    isStandalone: window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true,
    vapidKeyConfigured: VAPID_PUBLIC_KEY.length > 0,
  })
}

async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(WORKER_URL, { scope: '/', updateViaCache: 'none' })
  return navigator.serviceWorker.ready
}

export async function thisDeviceSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  return (await reg?.pushManager.getSubscription()) ?? null
}

async function saveSubscription(sub: PushSubscription) {
  const json = sub.toJSON()
  const { error } = await supabase.rpc('register_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh,
    p_auth: json.keys?.auth,
    p_user_agent: deviceLabel(navigator.userAgent),
  })
  if (error) throw new Error(error.message)
}

// False after the server's VAPID keys were rotated: that subscription can no
// longer receive pushes and must be replaced.
export const subscriptionUsesCurrentKey = (sub: PushSubscription) => {
  const key = sub.options?.applicationServerKey
  return !key || uint8ArrayToBase64Url(new Uint8Array(key)) === VAPID_PUBLIC_KEY
}
const sameKey = subscriptionUsesCurrentKey

// Must be called directly from a click: browsers (and iOS especially) only
// show the permission prompt in response to a user gesture.
export async function enablePushOnThisDevice(): Promise<void> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for this site. Allow them in your browser or device settings, then try again.'
      : 'Notifications were not enabled.')
  }
  const reg = await pushRegistration()
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub)) {
    await supabase.rpc('delete_push_subscription', { p_id: null, p_endpoint: sub.endpoint })
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // Freshly allocated, so its buffer is exactly the 65-byte key.
    applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
  })
  await saveSubscription(sub)
}

export async function disablePushOnThisDevice(): Promise<void> {
  const sub = await thisDeviceSubscription()
  if (!sub) return
  const { error } = await supabase.rpc('delete_push_subscription', { p_id: null, p_endpoint: sub.endpoint })
  await sub.unsubscribe().catch(() => false)
  if (error) throw new Error(error.message)
}

// Keeps this device registered to the signed-in account (e.g. after another
// account used this browser, or the server removed an expired subscription).
export async function syncPushSubscription(): Promise<void> {
  if (currentPushSupport().state !== 'granted') return
  const sub = await thisDeviceSubscription()
  if (sub && sameKey(sub)) await saveSubscription(sub)
}

export async function loadDevices(): Promise<PushDevice[]> {
  const { data, error } = await supabase.from('push_subscriptions')
    .select('id, endpoint, user_agent, created_at, last_seen_at, last_success_at')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as PushDevice[]
}

export async function removeDevice(device: PushDevice): Promise<void> {
  const local = await thisDeviceSubscription().catch(() => null)
  const { error } = await supabase.rpc('delete_push_subscription', { p_id: device.id, p_endpoint: null })
  if (error) throw new Error(error.message)
  if (local?.endpoint === device.endpoint) await local.unsubscribe().catch(() => false)
}

// Same-origin lead links only (from the service worker).
export const isLeadPath = (path: unknown): path is string => typeof path === 'string' && LEAD_PATH_RE.test(path)
