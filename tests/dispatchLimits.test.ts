// Lease-safety arithmetic for notification-dispatch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPLETION_MARGIN_MS, LEASE_SECONDS, MAX_REQUEST_TIMEOUT_MS, MAX_RUN_BUDGET_MS, canStartDelivery, dispatchLimits,
} from '../supabase/functions/_shared/dispatchLimits.ts'

test('the longest possible run finishes its last request well inside the lease', () => {
  assert.ok(MAX_RUN_BUDGET_MS + MAX_REQUEST_TIMEOUT_MS + COMPLETION_MARGIN_MS < LEASE_SECONDS * 1000)
})

test('overrides are clamped to the safe maxima', () => {
  const env = (values: Record<string, string>) => (k: string) => values[k]
  assert.deepEqual(dispatchLimits(env({})), { requestTimeoutMs: MAX_REQUEST_TIMEOUT_MS, runBudgetMs: MAX_RUN_BUDGET_MS, leaseMs: 120_000, marginMs: COMPLETION_MARGIN_MS })
  const huge = dispatchLimits(env({ NOTIFICATION_REQUEST_TIMEOUT_MS: '999999', NOTIFICATION_RUN_BUDGET_MS: '999999' }))
  assert.deepEqual([huge.requestTimeoutMs, huge.runBudgetMs], [MAX_REQUEST_TIMEOUT_MS, MAX_RUN_BUDGET_MS])
  for (const bad of ['abc', '0', '-5', '']) {
    assert.equal(dispatchLimits(env({ NOTIFICATION_REQUEST_TIMEOUT_MS: bad })).requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS, bad)
  }
  assert.equal(dispatchLimits(env({ NOTIFICATION_REQUEST_TIMEOUT_MS: '250' })).requestTimeoutMs, 250)
})

test('a delivery may only start if it can finish inside both the run budget and the batch lease', () => {
  const limits = { requestTimeoutMs: 10_000, runBudgetMs: 45_000, leaseMs: 120_000, marginMs: 20_000 }
  const t = 1_000_000
  assert.equal(canStartDelivery(limits, t, t, t), true)
  assert.equal(canStartDelivery(limits, t + 35_000, t, t), true, 'last start that fits the budget')
  assert.equal(canStartDelivery(limits, t + 35_001, t, t), false)
  // Even with budget left, a batch whose lease is nearly used up stops.
  const roomy = { ...limits, runBudgetMs: 10 ** 9 }
  assert.equal(canStartDelivery(roomy, t + 90_000, t, t), true)
  assert.equal(canStartDelivery(roomy, t + 90_001, t, t), false)
})
