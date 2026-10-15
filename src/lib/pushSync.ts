// Page-load/login sync for this browser's push subscription. It only
// REFRESHES a registration the signed-in user still owns; it never creates
// one. Creating happens solely through an explicit "Enable notifications"
// tap, so a device removed from another device (or on sign-out, or by the
// server after expiry) stays off until someone re-enables it here.
// Dependencies are injected so this runs in Node tests.

export type LocalSubscription = {
  endpoint: string
  p256dh: string
  auth: string
  usesCurrentKey: boolean
  unsubscribe: () => Promise<unknown>
}

export type DeviceStatus = 'active' | 'missing' | 'other_user'

export type SyncResult = 'none' | 'active' | 'removed' | 'stale_key'

export async function syncThisDevice(deps: {
  getSubscription: () => Promise<LocalSubscription | null>
  touch: (endpoint: string, p256dh: string, auth: string) => Promise<DeviceStatus>
}): Promise<SyncResult> {
  const sub = await deps.getSubscription()
  if (!sub) return 'none'
  // Made with rotated-out server keys: leave it for the settings page to
  // replace on an explicit Enable.
  if (!sub.usesCurrentKey) return 'stale_key'
  const status = await deps.touch(sub.endpoint, sub.p256dh, sub.auth)
  if (status === 'active') return 'active'
  // Removed for this account, or now belongs to another account: drop the
  // browser's subscription too so the device shows notifications as off.
  await sub.unsubscribe().catch(() => false)
  return 'removed'
}
