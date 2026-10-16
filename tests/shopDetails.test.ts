import { test } from 'node:test'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).window = new EventTarget()
const { EMAIL_MAX, NAME_MAX, announceShopDetailsChange, changedFields, draftFrom, onShopDetailsChange, validateShopDetails } =
  await import('../src/lib/shopDetails.ts')

const shop = { name: 'Ridge Fab', contact_email: 'owner@ridgefab.example', phone: '(555) 010-2030' }
const valid = draftFrom(shop)

test('draft starts from the saved values, with blanks for missing ones', () => {
  assert.deepEqual(valid, { name: 'Ridge Fab', contact_email: 'owner@ridgefab.example', phone: '(555) 010-2030' })
  assert.deepEqual(draftFrom({ name: 'X', contact_email: null, phone: null }), { name: 'X', contact_email: '', phone: '' })
})

test('name and contact email are required; phone is optional', () => {
  assert.deepEqual(validateShopDetails(valid), {})
  assert.deepEqual(validateShopDetails({ ...valid, phone: '' }), {}, 'phone may be blank')
  assert.deepEqual(validateShopDetails({ ...valid, phone: '   ' }), {})
  assert.match(validateShopDetails({ ...valid, name: '   ' }).name!, /Enter your shop name/)
  assert.match(validateShopDetails({ ...valid, name: 'x'.repeat(NAME_MAX + 1) }).name!, /under/)
  assert.match(validateShopDetails({ ...valid, contact_email: '' }).contact_email!, /Enter a contact email/)
})

test('contact emails must be deliverable addresses', () => {
  for (const ok of ['owner@ridgefab.example', ' Owner.Name+quotes@shop.co.uk ', 'a@b.io']) {
    assert.equal(validateShopDetails({ ...valid, contact_email: ok }).contact_email, undefined, ok)
  }
  for (const bad of ['owner', 'owner@', '@shop.com', 'owner@shop', 'two@@shop.com', 'a b@shop.com', 'a@shop.com, b@shop.com',
    'Owner <owner@shop.com>', 'a;b@shop.com', `${'a'.repeat(EMAIL_MAX)}@shop.com`]) {
    assert.ok(validateShopDetails({ ...valid, contact_email: bad }).contact_email, bad)
  }
})

test('phone numbers allow common formats and reject junk', () => {
  for (const ok of ['555-010-2030', '+1 (555) 010-2030', '555.010.2030', '+44 20 7946 0958', '555-010-2030 ext. 12', '5550102030 x7']) {
    assert.equal(validateShopDetails({ ...valid, phone: ok }).phone, undefined, ok)
  }
  for (const bad of ['call me', '123', '555-CALL-NOW', '<script>', '1'.repeat(41)]) {
    assert.ok(validateShopDetails({ ...valid, phone: bad }).phone, bad)
  }
})

test('only changed fields are saved, trimmed, with a blank phone cleared', () => {
  assert.deepEqual(changedFields(valid, valid), {})
  assert.deepEqual(changedFields(valid, { ...valid, name: '  Ridge Fab  ' }), {}, 'whitespace-only edits are not changes')
  assert.deepEqual(changedFields(valid, { ...valid, name: ' Ridge Fabrication ' }), { name: 'Ridge Fabrication' })
  assert.deepEqual(changedFields(valid, { ...valid, contact_email: 'quotes@ridgefab.example' }), { contact_email: 'quotes@ridgefab.example' })
  assert.deepEqual(changedFields(valid, { ...valid, phone: '' }), { phone: null })
  assert.deepEqual(changedFields({ ...valid, phone: '' }, { ...valid, phone: '' }), {})
  assert.deepEqual(changedFields(valid, { name: 'A', contact_email: 'b@c.io', phone: '555 010 9999' }),
    { name: 'A', contact_email: 'b@c.io', phone: '555 010 9999' })
})

test('a saved name is announced so the sidebar refreshes', () => {
  const seen: unknown[] = []
  const stop = onShopDetailsChange((c) => seen.push(c))
  announceShopDetailsChange({ shopId: 'shop-1', name: 'Ridge Fabrication' })
  stop()
  announceShopDetailsChange({ shopId: 'shop-1', name: 'ignored after unsubscribe' })
  assert.deepEqual(seen, [{ shopId: 'shop-1', name: 'Ridge Fabrication' }])
})
