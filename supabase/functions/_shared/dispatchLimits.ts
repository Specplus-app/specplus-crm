// Time limits for notification-dispatch. A claimed delivery is leased for
// LEASE_SECONDS (claim_notification_deliveries); another worker may take it
// over only after that. To make sure a worker never still has a provider
// request in flight when its lease can expire:
//   - every provider request is aborted after the request timeout;
//   - a delivery is only started if the request timeout plus a completion
//     margin still fits both inside the run budget and inside that batch's
//     lease; otherwise the remaining deliveries are released unsent;
//   - the run budget + request timeout + margin is below the lease.
// Overrides (tests, tuning) are clamped to these maxima.

export const LEASE_SECONDS = 120 // keep in sync with claim_notification_deliveries
export const MAX_REQUEST_TIMEOUT_MS = 10_000
export const MAX_RUN_BUDGET_MS = 45_000
export const COMPLETION_MARGIN_MS = 20_000
// Bounded wait for the dispatcher's own database calls.
export const DB_TIMEOUT_MS = 15_000

export type DispatchLimits = { requestTimeoutMs: number; runBudgetMs: number; leaseMs: number; marginMs: number }

const clamp = (value: string | undefined, max: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : max
}

export function dispatchLimits(env: (k: string) => string | undefined): DispatchLimits {
  return {
    requestTimeoutMs: clamp(env('NOTIFICATION_REQUEST_TIMEOUT_MS'), MAX_REQUEST_TIMEOUT_MS),
    runBudgetMs: clamp(env('NOTIFICATION_RUN_BUDGET_MS'), MAX_RUN_BUDGET_MS),
    leaseMs: LEASE_SECONDS * 1000,
    marginMs: COMPLETION_MARGIN_MS,
  }
}

// May another provider request start now? Checked before every delivery.
export function canStartDelivery(limits: DispatchLimits, now: number, runStarted: number, batchClaimed: number): boolean {
  const needed = limits.requestTimeoutMs
  return now - runStarted + needed <= limits.runBudgetMs
    && now - batchClaimed + needed + limits.marginMs <= limits.leaseMs
}

export const isTimeout = (err: unknown) =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
