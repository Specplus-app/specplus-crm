// Deposit helpers (src/lib/deposits.ts). The database enforces the same rules
// (tests/instantBooking.db.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUOTE_DEPOSIT_LINK_REQUIRED, depositStatus, draftFromDeposit, isSafePaymentUrl, parseDepositAmount, quoteDepositEffect, validateDepositDraft,
  validateQuoteDeposit,
} from '../src/lib/deposits.ts'

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

// The quote builder's "Request a deposit" section (quotes.deposit_*).
test('quote deposit off saves nothing, even with leftover field text', () => {
  const r = validateQuoteDeposit(false, { payment_url: 'not a url', amount: 'abc', instructions: 'x' })
  assert.deepEqual(r.errors, {})
  assert.deepEqual(r.values, { deposit_requested: false, deposit_payment_url: null, deposit_amount: null, deposit_instructions: null })
})

test('quote deposit on needs this quote’s https link; amount and instructions are optional', () => {
  assert.equal(validateQuoteDeposit(true, { payment_url: '', amount: '', instructions: 'Pay at drop-off' }).errors.payment_url, QUOTE_DEPOSIT_LINK_REQUIRED)
  assert.match(validateQuoteDeposit(true, { payment_url: 'http://pay.example.com/x', amount: '', instructions: '' }).errors.payment_url ?? '', /secure payment link/)
  assert.match(validateQuoteDeposit(true, { payment_url: 'https://pay.example.com/x', amount: '0', instructions: '' }).errors.amount ?? '', /between/)
  const ok = validateQuoteDeposit(true, { payment_url: '  https://invoices.example.com/inv/42 ', amount: '$1,250.50', instructions: '  Due in 3 days. ' })
  assert.deepEqual(ok.errors, {})
  assert.deepEqual(ok.values, {
    deposit_requested: true, deposit_payment_url: 'https://invoices.example.com/inv/42', deposit_amount: 1250.5, deposit_instructions: 'Due in 3 days.',
  })
  const linkOnly = validateQuoteDeposit(true, { payment_url: 'https://invoices.example.com/inv/43', amount: '', instructions: '' })
  assert.deepEqual([linkOnly.values.deposit_amount, linkOnly.values.deposit_instructions], [null, null])
})

test('reopening a draft restores its saved deposit fields', () => {
  assert.deepEqual(draftFromDeposit({ payment_url: 'https://invoices.example.com/inv/7', amount: 150, instructions: 'Thanks' }),
    { payment_url: 'https://invoices.example.com/inv/7', amount: '150.00', instructions: 'Thanks' })
})

test('the quote screen describes which deposit a booking will actually use', () => {
  const draft = { status: 'draft', sent_at: null }
  const sent = { status: 'sent', sent_at: '2026-11-10T12:00:00Z' }
  assert.equal(quoteDepositEffect(null, draft), 'quote')
  // Older, unbooked, unreceived lead settings (either "$75" or "no deposit") are replaced by the quote.
  const older = { attached_at: null, received_at: null, updated_at: '2026-11-09T12:00:00Z' }
  assert.equal(quoteDepositEffect(older, draft), 'quote_replaces')
  assert.equal(quoteDepositEffect(older, sent), 'quote_replaces')
  // A lead correction saved after the quote was sent applies.
  assert.equal(quoteDepositEffect({ ...older, updated_at: '2026-11-11T08:00:00Z' }, sent), 'lead_correction')
  // Tied to a booking, or received: kept.
  assert.equal(quoteDepositEffect({ ...older, attached_at: '2026-11-11T08:00:00Z' }, draft), 'booking_kept')
  assert.equal(quoteDepositEffect({ ...older, received_at: '2026-11-11T08:00:00Z' }, sent), 'booking_kept')
})
