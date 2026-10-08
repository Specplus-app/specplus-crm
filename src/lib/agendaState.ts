// Load state for the weekly agenda. Each load carries a sequence number and
// the shop/week it is for; responses that arrive out of order are ignored,
// and switching to another shop/week clears the previous week's rows before
// anything new arrives (also when that load then fails). Pure, unit tested.

export type AgendaState<J, P> = {
  key: string | null
  latest: number
  status: 'loading' | 'ready' | 'error'
  jobs: J[]
  pending: P[]
  // True once rows for this key loaded successfully; a failed first load
  // must not look like an empty week.
  loaded: boolean
  error: string | null
}

export type AgendaAction<J, P> =
  | { type: 'loadStart'; id: number; key: string }
  | { type: 'loadSuccess'; id: number; jobs: J[]; pending: P[] }
  | { type: 'loadFailure'; id: number; error: string }

export function agendaKey(shopId: string, weekStart: string): string {
  return `${shopId}|${weekStart}`
}

export function initialAgenda<J, P>(): AgendaState<J, P> {
  return { key: null, latest: 0, status: 'loading', jobs: [], pending: [], loaded: false, error: null }
}

export function agendaReducer<J, P>(state: AgendaState<J, P>, action: AgendaAction<J, P>): AgendaState<J, P> {
  switch (action.type) {
    case 'loadStart': {
      const sameView = action.key === state.key
      return {
        key: action.key,
        latest: action.id,
        status: 'loading',
        jobs: sameView ? state.jobs : [],
        pending: sameView ? state.pending : [],
        loaded: sameView ? state.loaded : false,
        error: null,
      }
    }
    case 'loadSuccess':
      if (action.id !== state.latest) return state
      return { ...state, status: 'ready', jobs: action.jobs, pending: action.pending, loaded: true, error: null }
    case 'loadFailure':
      if (action.id !== state.latest) return state
      return { ...state, status: 'error', error: action.error }
  }
}
