import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOLLOW_UP_COOLDOWN_MS, activeCustomerQuote, describeFollowUpResult, followUpAvailability, followUpPrefill } from '../src/lib/quoteFollowUp.ts'

const now = new Date('2026-10-19T15:00:00Z')
const sent = { status: 'sent' as const, superseded_at: null, expires_at: null }

test('sent and viewed current quotes can be followed up', () => {
  assert.deepEqual(followUpAvailability(sent, 'quote_sent', null, now), { available: true })
  assert.deepEqual(followUpAvailability({ ...sent, status: 'viewed' }, 'quote_sent', null, now), { available: true })
  assert.deepEqual(followUpAvailability({ ...sent, expires_at: '2026-10-19' }, 'quote_sent', null, now), { available: true }, 'valid through its expiry date')
})

test('drafts, answered, revised and expired quotes cannot', () => {
  assert.deepEqual(followUpAvailability({ ...sent, status: 'draft' }, 'quote_sent', null, now), { available: false, reason: 'not_sent' })
  assert.deepEqual(followUpAvailability({ ...sent, status: 'approved' }, 'quote_sent', null, now), { available: false, reason: 'responded' })
  assert.deepEqual(followUpAvailability({ ...sent, status: 'declined' }, 'quote_sent', null, now), { available: false, reason: 'responded' })
  assert.deepEqual(followUpAvailability({ ...sent, superseded_at: '2026-10-18T00:00:00Z' }, 'quote_sent', null, now), { available: false, reason: 'superseded' })
  assert.deepEqual(followUpAvailability({ ...sent, expires_at: '2026-10-18' }, 'quote_sent', null, now), { available: false, reason: 'expired' })
})

test('one follow-up every 24 hours', () => {
  const recent = new Date(now.getTime() - FOLLOW_UP_COOLDOWN_MS + 60_000).toISOString()
  const r = followUpAvailability(sent, 'quote_sent', recent, now)
  assert.equal(r.available, false)
  assert.ok(!r.available && r.reason === 'cooldown')
  assert.equal((r as { nextAllowedAt: Date }).nextAllowedAt.toISOString(), new Date(now.getTime() + 60_000).toISOString())
  const old = new Date(now.getTime() - FOLLOW_UP_COOLDOWN_MS).toISOString()
  assert.deepEqual(followUpAvailability(sent, 'quote_sent', old, now), { available: true })
})

test('prefilled message greets the customer by first name and invites a reply on the quote', () => {
  const text = followUpPrefill('Jordan Q. Customer', '2021 Bronco')
  assert.match(text, /^Hi Jordan,/)
  assert.match(text, /your quote for your 2021 Bronco\./)
  assert.match(text, /reply right here on your quote/)
  assert.match(followUpPrefill(null, null), /^Hi there,[\s\S]*checking in on your quote\./)
})

const fmt = (iso: string) => `<${iso}>`

test('posting and alert delivery are reported separately', () => {
  const base = { ok: true as const, duplicate: false, message_id: 'm', created_at: '2026-10-19T15:00:00Z' }
  const queued = describeFollowUpResult({ ...base, alert: 'queued' }, fmt)
  assert.equal(queued.posted, true)
  assert.equal(queued.message, 'Follow-up posted to the conversation. Email alert queued.')
  assert.doesNotMatch(queued.message, /will (get|receive)/, 'never promises delivery')
  assert.equal(queued.alertWarning, undefined)

  const noEmail = describeFollowUpResult({ ...base, alert: 'no_customer_email' }, fmt)
  assert.equal(noEmail.posted, true)
  assert.match(noEmail.message, /posted to the conversation/)
  assert.match(noEmail.alertWarning!, /No email alert was sent/)

  const notQueued = describeFollowUpResult({ ...base, alert: 'not_queued' }, fmt)
  assert.equal(notQueued.posted, true)
  assert.match(notQueued.alertWarning!, /couldn't be queued/)

  const dup = describeFollowUpResult({ ...base, duplicate: true, alert: 'already_handled' }, fmt)
  assert.equal(dup.posted, true)
  assert.match(dup.message, /already posted/)
})

test('refusals explain what to do next', () => {
  const cooldown = describeFollowUpResult({ ok: false, error: 'cooldown', last_follow_up_at: 'a', next_allowed_at: '2026-10-20T15:00:00Z' }, fmt)
  assert.equal(cooldown.posted, false)
  assert.match(cooldown.message, /after <2026-10-20T15:00:00Z>/)
  assert.match(describeFollowUpResult({ ok: false, error: 'not_eligible', reason: 'expired' }, fmt).message, /expired.*Revise/)
  assert.match(describeFollowUpResult({ ok: false, error: 'not_eligible', reason: 'superseded' }, fmt).message, /revised/)
  assert.match(describeFollowUpResult({ ok: false, error: 'not_eligible', reason: 'approved' }, fmt).message, /already responded/)
  assert.match(describeFollowUpResult({ ok: false, error: 'not_eligible', reason: 'draft' }, fmt).message, /Only sent quotes/)
  assert.match(describeFollowUpResult({ ok: false, error: 'invalid_message' }, fmt).message, /between 1 and 5000/)
})

test('follow-ups target the active sent quote, not a newer unsent draft', () => {
  const q = (revision_number: number, status: string, superseded_at: string | null = null) =>
    ({ id: `q${revision_number}`, revision_number, status: status as 'sent', superseded_at })
  // Draft revision #2 pending: the customer still has #1.
  assert.equal(activeCustomerQuote([q(2, 'draft'), q(1, 'viewed')])?.id, 'q1')
  // Order of the input doesn't matter.
  assert.equal(activeCustomerQuote([q(1, 'sent', '2026-10-01'), q(3, 'draft'), q(2, 'sent')])?.id, 'q2')
  // Once #2 is sent it supersedes #1.
  assert.equal(activeCustomerQuote([q(2, 'sent'), q(1, 'viewed', '2026-10-19')])?.id, 'q2')
  // Answered quotes are still the active one (follow-up availability rejects them separately).
  assert.equal(activeCustomerQuote([q(1, 'approved')])?.id, 'q1')
  assert.equal(activeCustomerQuote([q(1, 'draft')]), null)
  assert.equal(activeCustomerQuote([]), null)
})

test('completed and lost leads cannot be followed up', () => {
  for (const status of ['completed', 'lost'] as const) {
    assert.deepEqual(followUpAvailability(sent, status, null, now), { available: false, reason: 'lead_closed' })
  }
  for (const status of ['quote_sent', 'viewed', 'quoting', 'new', 'contacted'] as const) {
    assert.deepEqual(followUpAvailability(sent, status, null, now), { available: true }, status)
  }
  assert.match(describeFollowUpResult({ ok: false, error: 'not_eligible', reason: 'lead_completed' }, fmt).message, /completed leads/)
  assert.match(describeFollowUpResult({ ok: false, error: 'not_eligible', reason: 'lead_lost' }, fmt).message, /lost leads/)
})
