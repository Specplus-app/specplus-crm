import { createContext, useContext } from 'react'

export type ShopBillingState = {
  loading: boolean
  readOnly: boolean
  isTrialing: boolean
  isLifetimeFree: boolean
  trialDaysLeft: number
}

export const DEFAULT_BILLING: ShopBillingState = {
  loading: false,
  readOnly: false,
  isTrialing: false,
  isLifetimeFree: false,
  trialDaysLeft: 0,
}

const ShopBillingContext = createContext<ShopBillingState>(DEFAULT_BILLING)

export const ShopBillingProvider = ShopBillingContext.Provider

export function useShopBilling(): ShopBillingState {
  return useContext(ShopBillingContext)
}

type ShopBillingInput = {
  subscription_status: string
  trial_ends_at: string | null
  is_lifetime_free: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

export function computeBilling(shop: ShopBillingInput | null): ShopBillingState {
  if (!shop) return { ...DEFAULT_BILLING }

  const isLifetimeFree = shop.is_lifetime_free === true
  const status = shop.subscription_status
  const isActive = status === 'active'
  const hasTrialStatus = status === 'trial' || status === 'trialing'
  const trialEnd = shop.trial_ends_at ? new Date(shop.trial_ends_at).getTime() : null
  const now = Date.now()
  const trialIsCurrent = hasTrialStatus && trialEnd !== null && Number.isFinite(trialEnd) && trialEnd >= now

  // Lifetime-free and active shops always retain write access. Trial shops are
  // writable only while their trial is current. Suspended/cancelled (and any
  // unknown non-active status) are read-only immediately, regardless of date.
  const readOnly = !isLifetimeFree && !isActive && !trialIsCurrent
  const isTrialing = !isLifetimeFree && trialIsCurrent
  const trialDaysLeft = trialIsCurrent && trialEnd !== null
    ? Math.max(0, Math.ceil((trialEnd - now) / DAY_MS))
    : 0

  return { loading: false, readOnly, isTrialing, isLifetimeFree, trialDaysLeft }
}
