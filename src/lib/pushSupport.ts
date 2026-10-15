// Pure helpers for staff push notifications (unit tested; no browser APIs are
// touched here so they can run in Node).

export type PushSupport =
  | { state: 'unsupported'; reason: string }
  // iPhone/iPad: Web Push only works from the Home Screen app (iOS 16.4+).
  | { state: 'ios-install' }
  | { state: 'blocked' }
  | { state: 'ready' } // supported; permission not decided yet
  | { state: 'granted' }

export type PushEnvironment = {
  isSecureContext: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  permission: NotificationPermission | null
  isIOS: boolean
  isStandalone: boolean
  vapidKeyConfigured: boolean
}

export function detectPushSupport(env: PushEnvironment): PushSupport {
  if (!env.vapidKeyConfigured) return { state: 'unsupported', reason: 'Push notifications are not configured for this site yet.' }
  if (!env.isSecureContext) return { state: 'unsupported', reason: 'Push notifications need a secure (https) connection.' }
  if (env.isIOS && !env.isStandalone) return { state: 'ios-install' }
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return {
      state: 'unsupported',
      reason: env.isIOS
        ? 'Update this iPhone or iPad to iOS 16.4 or later to receive notifications.'
        : 'This browser does not support push notifications.',
    }
  }
  if (env.permission === 'denied') return { state: 'blocked' }
  if (env.permission === 'granted') return { state: 'granted' }
  return { state: 'ready' }
}

export function isIOSDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)
}

// Short, non-identifying label so staff can tell their devices apart.
export function deviceLabel(userAgent: string): string {
  const os = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
    : /Android/.test(userAgent) ? 'Android'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac'
    : /Linux|CrOS/.test(userAgent) ? 'Linux'
    : 'Device'
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /SamsungBrowser/.test(userAgent) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(userAgent) ? 'Firefox'
    : /Chrome|CriOS/.test(userAgent) ? 'Chrome'
    : /Safari/.test(userAgent) ? 'Safari'
    : ''
  return browser ? `${os} · ${browser}` : os
}

export function base64UrlToUint8Array(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Where to go after signing in: only same-site app paths for the user's own
// area (a notification link, or a page the session expired on).
export function safeReturnPath(from: unknown, role: 'admin' | 'shop_user'): string | null {
  if (typeof from !== 'string' || from.length > 500) return null
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return null
  const area = role === 'admin' ? '/admin' : '/dashboard'
  if (from !== area && !from.startsWith(`${area}/`) && !from.startsWith(`${area}?`)) return null
  return from
}

// Notification targets opened from push notifications.
export const LEAD_PATH_RE = /^\/dashboard\/leads\/[0-9a-f-]{36}$/
