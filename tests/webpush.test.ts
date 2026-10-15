// Web Push encryption and VAPID signing (supabase/functions/_shared/webpush.ts)
// checked against the RFC 8291 test vector and an independent node:crypto
// receiver. No push service is contacted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import {
  b64urlDecode, b64urlEncode, classifyPushStatus, encryptPayload, pushEndpointIsAllowed, sendWebPush, vapidAuthorization,
} from '../supabase/functions/_shared/webpush.ts'
import { decryptPush as decrypt, newReceiver, newVapid } from './helpers/pushReceiver.ts'

// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('matches the RFC 8291 Appendix A test vector exactly', async () => {
  const body = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, new TextEncoder().encode(RFC.plaintext), {
    salt: b64urlDecode(RFC.salt),
    senderPrivateKey: b64urlDecode(RFC.asPrivate),
    senderPublicKey: b64urlDecode(RFC.asPublic),
  })
  assert.equal(b64urlEncode(body), RFC.message)
  assert.equal(decrypt(body, b64urlDecode(RFC.uaPrivate), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.auth)), RFC.plaintext)
})

test('random-key messages decrypt with an independent receiver', async () => {
  const r = newReceiver()
  const text = JSON.stringify({ title: 'New request', url: '/dashboard/leads/abc' })
  const a = await encryptPayload(r.keys, new TextEncoder().encode(text))
  const b = await encryptPayload(r.keys, new TextEncoder().encode(text))
  assert.notEqual(b64urlEncode(a), b64urlEncode(b), 'fresh salt and sender key per message')
  assert.equal(decrypt(a, r.priv, r.pub, r.auth), text)
  const other = newReceiver()
  assert.throws(() => decrypt(a, other.priv, other.pub, other.auth), 'only the subscribed browser can read it')
})

test('VAPID authorization is a valid ES256 JWT for the push service origin', async () => {
  const vapid = newVapid()
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 1_800_000_000)
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
  assert.ok(m)
  const [, h, c, sig, k] = m
  assert.equal(k, vapid.publicKey)
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(h)).toString()), { typ: 'JWT', alg: 'ES256' })
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(c)).toString()), {
    aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'mailto:alerts@example.test',
  })
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: vapid.jwk.x, y: vapid.jwk.y }, format: 'jwk' })
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(sig))))
  assert.ok(!verify('sha256', Buffer.from(`${h}.${c}x`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(sig))))
})

test('push service responses map to delivery outcomes', () => {
  assert.deepEqual([200, 201, 202].map(classifyPushStatus), ['sent', 'sent', 'sent'])
  assert.deepEqual([404, 410].map(classifyPushStatus), ['gone', 'gone'])
  assert.deepEqual([429, 500, 502, 503].map(classifyPushStatus), ['retry', 'retry', 'retry', 'retry'])
  assert.deepEqual([400, 401, 403, 413].map(classifyPushStatus), ['failed', 'failed', 'failed', 'failed'])
})

test('only known push services are contacted', async () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/a', 'https://web.push.apple.com/QA', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.ok(pushEndpointIsAllowed(ok), ok)
  }
  for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://fcm.googleapis.com@evil.test/x', 'https://127.0.0.1/x', 'https://evil.test/push.apple.com/x']) {
    assert.ok(!pushEndpointIsAllowed(bad), bad)
  }
  const realFetch = globalThis.fetch
  let called = false
  globalThis.fetch = (async () => { called = true; return new Response(null, { status: 201 }) }) as typeof fetch
  try {
    const r = newReceiver()
    const res = await sendWebPush({ endpoint: 'https://169.254.169.254/latest', ...r.keys }, { title: 'x' }, newVapid())
    assert.deepEqual(res, { outcome: 'failed', error: 'endpoint_not_allowed' })
    assert.equal(called, false)
  } finally {
    globalThis.fetch = realFetch
  }
})
