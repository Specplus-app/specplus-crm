// An independent Web Push receiver (what a browser does), written against
// node:crypto rather than WebCrypto so it does not share code with the sender.
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync } from 'node:crypto'
import { b64urlDecode, b64urlEncode } from '../../supabase/functions/_shared/webpush.ts'

export function decryptPush(body: Uint8Array, uaPrivate: Uint8Array, uaPublic: Uint8Array, auth: Uint8Array): string {
  const buf = Buffer.from(body)
  const salt = buf.subarray(0, 16)
  const recordSize = buf.readUInt32BE(16)
  const idLen = buf[20]
  const asPublic = buf.subarray(21, 21 + idLen)
  const ciphertext = buf.subarray(21 + idLen)
  assert.equal(recordSize, 4096)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(uaPrivate))
  const secret = ecdh.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublic), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  const end = padded.lastIndexOf(2)
  assert.ok(end >= 0 && padded.subarray(end + 1).every((b) => b === 0), 'final record delimiter')
  return padded.subarray(0, end).toString('utf8')
}

export function newReceiver() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const priv = new Uint8Array(ecdh.getPrivateKey())
  const pub = new Uint8Array(ecdh.getPublicKey())
  return {
    priv,
    pub,
    auth,
    keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) },
    decrypt: (body: Uint8Array) => decryptPush(body, priv, pub, auth),
  }
}

export function newVapid() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string }
  const pub = new Uint8Array([4, ...b64urlDecode(jwk.x), ...b64urlDecode(jwk.y)])
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d, subject: 'mailto:alerts@example.test', jwk }
}
