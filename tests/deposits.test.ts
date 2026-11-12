// Deposit helpers (src/lib/deposits.ts). The database enforces the same rules
// (tests/instantBooking.db.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depositStatus, draftFromDeposit, isSafePaymentUrl, parseDepositAmount, validateDepositDraft } from '../src/lib/deposits.ts'

test('only safe https payment links are accepted, matching the server rule', () => {
  for (const bad of [
    'http://pay.example.com/x', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'https://user:pass@pay.example.com/x',
    'https://pay@example.com', 'https://pay.example.com/a b', 'https://localhost/pay', 'ftp://pay.example.com', ' https://pay.example.com',
    'https://pay.example.com/<script>', 'https://pay.example.com/"x', "https://pay.example.com/'x", 'https://pay.example.com/\\x',
    'https://pay.example.com/\nx', 'HTTPS://', 'https://.example.com', 'vbscript:msgbox', '//pay.example.com', '', null, 42,
  ]) {
    assert.equal(isSafePaymentUrl(bad), false, String(bad))
  }
  for (const good of ['https://pay.example.com', 'https://checkout.stripe.com/c/pay/cs_test_a1#fid=x', 'https://example.co.uk:8443/p?a=1&b=@x']) {
    assert.equal(isSafePaymentUrl(good), true, good)
  }
  assert.equal(isSafePaymentUrl(`https://pay.example.com/${'a'.repeat(2000)}`), false, 'too long')
})

test('deposit amounts are dollars and cents', () => {
  assert.deepEqual(parseDepositAmount(''), { amount: null, error: null })
  assert.deepEqual(parseDepositAmount(' $1,250.5 '), { amount: 1250.5, error: null })
  assert.deepEqual(parseDepositAmount('150'), { amount: 150, error: null })
  for (const bad of ['0', '-5', '10.005', 'abc', '1000000.01', '1e3']) assert.notEqual(parseDepositAmount(bad).error, null, bad)
})

test('the deposit form needs a link or instructions when a deposit is requested', () => {
  const blank = { payment_url: '', amount: '', instructions: '' }
  assert.match(validateDepositDraft(blank, true).errors.payment_url!, /payment link or payment instructions/)
  assert.deepEqual(validateDepositDraft(blank, false).errors, {}, 'a disabled default can be left blank')
  const instructionsOnly = validateDepositDraft({ ...blank, instructions: ' Pay at pickup. ' }, true)
  assert.deepEqual(instructionsOnly, { errors: {}, values: { payment_url: null, amount: null, instructions: 'Pay at pickup.' } })
  const bad = validateDepositDraft({ payment_url: 'http://x.example.com', amount: '1.234', instructions: 'x'.repeat(1001) }, true)
  assert.deepEqual(Object.keys(bad.errors).sort(), ['amount', 'instructions', 'payment_url'])
  assert.deepEqual(draftFromDeposit({ payment_url: 'https://pay.example.com', amount: 150, instructions: null }),
    { payment_url: 'https://pay.example.com', amount: '150.00', instructions: '' })
})

test('deposit status is separate from the project status', () => {
  assert.equal(depositStatus(null), 'not_required', 'legacy bookings have no deposit row')
  assert.equal(depositStatus({ requested: false, received_at: null }), 'not_required')
  assert.equal(depositStatus({ requested: true, received_at: null }), 'awaiting')
  assert.equal(depositStatus({ requested: true, received_at: '2026-11-11T12:00:00Z' }), 'received')
})
