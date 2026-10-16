import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PUBLIC_QUOTE_ORIGIN, copyText, customerLinkFor, publicQuoteOrigin } from '../src/lib/customerLink.ts'

const SHOP_ID = '3f1c2b9a-6d4e-4c1b-9a8e-2b7c5d6e7f80'

test('the quote origin comes from VITE_PUBLIC_QUOTE_ORIGIN, defaulting to quotes.specplus.app', () => {
  assert.equal(DEFAULT_PUBLIC_QUOTE_ORIGIN, 'https://quotes.specplus.app')
  for (const unset of [undefined, null, '', '   ']) assert.equal(publicQuoteOrigin(unset), DEFAULT_PUBLIC_QUOTE_ORIGIN)
  const preview = 'https://specplus-crm-git-feat-shop-settings-spec-plus.vercel.app'
  assert.equal(publicQuoteOrigin(preview), preview)
  assert.equal(publicQuoteOrigin(`${preview}/`), preview, 'trailing slash')
  assert.equal(publicQuoteOrigin(` ${preview}/some/path `), preview, 'origin only')
  assert.equal(publicQuoteOrigin('http://localhost:5173'), 'http://localhost:5173')
  for (const bad of ['quotes.specplus.app', 'javascript:alert(1)', 'ftp://example.com', 'not a url']) {
    assert.equal(publicQuoteOrigin(bad), DEFAULT_PUBLIC_QUOTE_ORIGIN, bad)
  }
})

test('the link uses the shop slug when present, otherwise /customize/{shop_id}', () => {
  const origin = DEFAULT_PUBLIC_QUOTE_ORIGIN
  assert.equal(customerLinkFor(origin, { id: SHOP_ID, slug: 'ridge-fab' }), 'https://quotes.specplus.app/ridge-fab')
  for (const slug of [null, undefined, '', '  ']) {
    assert.equal(customerLinkFor(origin, { id: SHOP_ID, slug }), `https://quotes.specplus.app/customize/${SHOP_ID}`, String(slug))
  }
  assert.equal(customerLinkFor('https://preview.example.test', { id: SHOP_ID, slug: 'ridge-fab' }), 'https://preview.example.test/ridge-fab')
})

test('copying uses the Clipboard API, falls back, and reports failure', async () => {
  const copied: string[] = []
  assert.equal(await copyText('link', { writeText: async (t) => { copied.push(t) }, fallbackCopy: () => { throw new Error('unused') } }), true)
  assert.deepEqual(copied, ['link'])

  let fallbackUsed = false
  const denied = async () => { throw new DOMException('Write permission denied', 'NotAllowedError') }
  assert.equal(await copyText('link', { writeText: denied, fallbackCopy: () => { fallbackUsed = true; return true } }), true)
  assert.equal(fallbackUsed, true, 'denied clipboard falls back (e.g. some Android browsers)')

  assert.equal(await copyText('link', { fallbackCopy: () => true }), true, 'no Clipboard API (non-secure context)')
  assert.equal(await copyText('link', { writeText: denied, fallbackCopy: () => false }), false)
  assert.equal(await copyText('link', { writeText: denied, fallbackCopy: () => { throw new Error('blocked') } }), false)
  assert.equal(await copyText('link', {}), false)
})
