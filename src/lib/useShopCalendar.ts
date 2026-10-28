import { useCallback, useEffect, useReducer, useRef } from 'react'
import { supabase } from './supabase'
import { agendaKey, agendaReducer, initialAgenda } from './agendaState'
import { loadShopCalendar, type CalendarJob, type CalendarRequest } from './calendarContext'
import type { DateOnly } from './scheduleDates'

// Loads (and reloads on demand) the calendar for a shop and date range.
// Out-of-order responses are ignored and rows from another shop or range
// are never shown (agendaReducer). `loaded` stays false until this range
// loads successfully, so a failed load never looks like an empty schedule;
// a failed refresh keeps the last loaded rows and reports the error.
export function useShopCalendar(shopId: string | null, rangeStart: DateOnly, rangeEnd: DateOnly) {
  const [agenda, dispatch] = useReducer(
    agendaReducer<CalendarJob, CalendarRequest>,
    undefined,
    () => initialAgenda<CalendarJob, CalendarRequest>(),
  )
  const loadSeq = useRef(0)
  const viewKey = shopId ? agendaKey(shopId, rangeStart, rangeEnd) : null

  const refresh = useCallback(async () => {
    if (!shopId) return
    const id = ++loadSeq.current
    dispatch({ type: 'loadStart', id, key: agendaKey(shopId, rangeStart, rangeEnd) })
    const { data, error } = await loadShopCalendar(supabase, shopId, rangeStart, rangeEnd)
    if (error || !data) dispatch({ type: 'loadFailure', id, error: error ?? 'Could not load the schedule.' })
    else dispatch({ type: 'loadSuccess', id, jobs: data.jobs, pending: data.pending })
  }, [shopId, rangeStart, rangeEnd])

  useEffect(() => {
    refresh()
  }, [refresh])

  const current = agenda.key === viewKey
  return {
    jobs: current ? agenda.jobs : [],
    pending: current ? agenda.pending : [],
    loading: !current || agenda.status === 'loading',
    loaded: current && agenda.loaded,
    error: current ? agenda.error : null,
    refresh,
  }
}
