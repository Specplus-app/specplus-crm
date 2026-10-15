// Standards-based Web Push using only WebCrypto (runs in Deno and Node):
//   RFC 8030 (HTTP push), RFC 8292 (VAPID), RFC 8291 + RFC 8188 (aes128gcm
//   message encryption).
// Payloads are end-to-end encrypted for the receiving browser; the push
// service only sees ciphertext.

export type PushTarget = { endpoint: string; p256dh: string; auth: string }
export type VapidKeys = { publicKey: string; privateKey: string; subject: string }
export type PushOutcome = 'sent' | 'retry' | 'failed' | 'gone'

const encoder = new TextEncoder()

export function b64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

// Same allow-list as public.push_endpoint_is_allowed: the dispatcher only ever
// POSTs to real browser push services, never to arbitrary URLs.
const PUSH_ENDPOINT_RE =
  /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\/[!-~]*$/

export function pushEndpointIsAllowed(endpoint: string): boolean {
  return typeof endpoint === 'string' && endpoint.length <= 1000 && PUSH_ENDPOINT_RE.test(endpoint)
}

// Raw uncompressed P-256 point (0x04 || x || y) → JWK coordinates.
function pointToJwk(point: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (point.length !== 65 || point[0] !== 4) throw new Error('Invalid P-256 public key')
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlEncode(point.slice(1, 33)), y: b64urlEncode(point.slice(33, 65)), ext: true }
  if (d) jwk.d = b64urlEncode(d)
  return jwk
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

export type EncryptOptions = {
  // Test hooks for the RFC 8291 vectors; normally random per message.
  salt?: Uint8Array
  senderPrivateKey?: Uint8Array
  senderPublicKey?: Uint8Array
}

// RFC 8291 §3.4 / RFC 8188: one aes128gcm record.
export async function encryptPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, plaintext: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(target.p256dh)
  const authSecret = b64urlDecode(target.auth)
  if (authSecret.length !== 16) throw new Error('Invalid push auth secret')
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))

  let asPrivate: CryptoKey
  let asPublic: Uint8Array
  if (opts.senderPrivateKey && opts.senderPublicKey) {
    asPublic = opts.senderPublicKey
    asPrivate = await crypto.subtle.importKey('jwk', pointToJwk(asPublic, opts.senderPrivateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    asPrivate = pair.privateKey
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256))

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

  // Single, final record: content followed by the 0x02 delimiter.
  const padded = concat(plaintext, new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded))

  const recordSize = new Uint8Array(4)
  new DataView(recordSize.buffer).setUint32(0, 4096)
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}

// RFC 8292: ES256-signed JWT for the push service's origin.
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const publicKey = b64urlDecode(vapid.publicKey)
  const privateKey = b64urlDecode(vapid.privateKey)
  if (privateKey.length !== 32) throw new Error('Invalid VAPID private key')
  const key = await crypto.subtle.importKey('jwk', pointToJwk(publicKey, privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 60 * 60,
    sub: vapid.subject,
  })))
  const signingInput = `${header}.${claims}`
  // WebCrypto ECDSA signatures are already raw r || s, as JWS requires.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput)))
  return `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${vapid.publicKey}`
}

// Push service responses (RFC 8030 §5, plus common provider behaviour).
export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'sent'
  if (status === 404 || status === 410) return 'gone' // subscription expired or unsubscribed
  if (status === 429 || status >= 500) return 'retry'
  return 'failed' // 400, 401/403 (VAPID mismatch), 413 (too large): retrying will not help
}

export type PushResult = { outcome: PushOutcome; status?: number; error?: string }

export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  vapid: VapidKeys,
  options: { ttlSeconds?: number; topic?: string; urgency?: 'normal' | 'high'; timeoutMs?: number } = {},
): Promise<PushResult> {
  if (!pushEndpointIsAllowed(target.endpoint)) {
    return { outcome: 'failed', error: 'endpoint_not_allowed' }
  }
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)))
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds ?? 12 * 60 * 60),
    Urgency: options.urgency ?? 'high',
  }
  // Topic (≤32 base64url chars) lets the push service collapse a duplicate
  // of the same notification that is still waiting for the device.
  if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.Topic = options.topic

  const timeoutMs = options.timeoutMs ?? 10_000
  try {
    // The signal also bounds reading the response body.
    const signal = AbortSignal.timeout(timeoutMs)
    const resp = await fetch(target.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal })
    const outcome = classifyPushStatus(resp.status)
    const detail = outcome === 'sent' ? undefined : `HTTP ${resp.status}${await resp.text().then((t) => (t ? `: ${t.slice(0, 200)}` : '')).catch(() => '')}`
    return { outcome, status: resp.status, error: detail }
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // The push service may still have accepted it; a retry can duplicate
      // (the shared Topic and notification tag usually collapse it).
      return { outcome: 'retry', error: `timeout after ${timeoutMs}ms` }
    }
    return { outcome: 'retry', error: `network: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }
  }
}
