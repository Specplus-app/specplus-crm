import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOLLOW_UP_COOLDOWN_MS, describeFollowUpResult, followUpAvailability, followUpPrefill } from '../src/lib/quoteFollowUp.ts'

const now = new Date('2026-10-19T15:00:00Z')
const sent = { status: 'sent' as const, superseded_at: null, expires_at: null }

test('sent and viewed current quotes can be followed up', () => {
  assert.deepEqual(followUpAvailability(sent, null, now), { available: true })
  assert.deepEqual(followUpAvailability({ ...sent, status: 'viewed' }, null, now), { available: true })
  assert.deepEqual(followUpAvailability({ ...sent, expires_at: '2026-10-19' }, null, now), { available: true }, 'valid through its expiry date')
})

test('drafts, answered, revised and expired quotes cannot', () => {
  assert.deepEqual(followUpAvailability({ ...sent, status: 'draft' }, null, now), { available: false, reason: 'not_sent' })
  assert.deepEqual(followUpAvailability({ ...sent, status: 'approved' }, null, now), { available: false, reason: 'responded' })
  assert.deepEqual(followUpAvailability({ ...sent, status: 'declined' }, null, now), { available: false, reason: 'responded' })
  assert.deepEqual(followUpAvailability({ ...sent, superseded_at: '2026-10-18T00:00:00Z' }, null, now), { available: false, reason: 'superseded' })
  assert.deepEqual(followUpAvailability({ ...sent, expires_at: '2026-10-18' }, null, now), { available: false, reason: 'expired' })
})

test('one follow-up every 24 hours', () => {
  const recent = new Date(now.getTime() - FOLLOW_UP_COOLDOWN_MS + 60_000).toISOString()
  const r = followUpAvailability(sent, recent, now)
  assert.equal(r.available, false)
  assert.ok(!r.available && r.reason === 'cooldown')
  assert.equal((r as { nextAllowedAt: Date }).nextAllowedAt.toISOString(), new Date(now.getTime() + 60_000).toISOString())
  const old = new Date(now.getTime() - FOLLOW_UP_COOLDOWN_MS).toISOString()
  assert.deepEqual(followUpAvailability(sent, old, now), { available: true })
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
  assert.match(queued.message, /posted to the conversation.*email alert/)
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
