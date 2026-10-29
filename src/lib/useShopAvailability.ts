import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { loadShopAvailability, type ShopAvailability } from './shopAvailability'
import type { DateOnly } from './scheduleDates'

// Loads (and reloads on demand) a shop's booking window and blocked dates
// from `from` on. Out-of-order responses are ignored; a failed refresh keeps
// the last loaded data and reports the error, and `data` stays null until a
// load succeeds, so a failure never looks like "nothing blocked".
export function useShopAvailability(shopId: string | null, from: DateOnly) {
  const [data, setData] = useState<ShopAvailability | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadSeq = useRef(0)

  const refresh = useCallback(async () => {
    if (!shopId) return
    const id = ++loadSeq.current
    setLoading(true)
    const res = await loadShopAvailability(supabase, shopId, from)
    if (id !== loadSeq.current) return
    setLoading(false)
    if (res.error || !res.data) setError(res.error ?? 'Could not load availability.')
    else {
      setData(res.data)
      setError(null)
    }
  }, [shopId, from])

  useEffect(() => {
    setData(null)
    setError(null)
    refresh()
  }, [refresh])

  return { data, loading, error, refresh }
}
