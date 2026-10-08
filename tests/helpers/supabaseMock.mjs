// Minimal stand-in for npm:@supabase/supabase-js used by edge-function tests.
// Behaviour is driven by globalThis.__supabaseMock, set by each test.
function query(table, state) {
  const filters = {}
  const matching = () => (state.tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
  const builder = {
    select: () => builder,
    eq: (column, value) => { filters[column] = value; return builder },
    maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
    // Awaiting the builder itself returns every matching row.
    then: (resolve, reject) => Promise.resolve({ data: matching(), error: null }).then(resolve, reject),
  }
  return builder
}

export function createClient(_url, key, options = {}) {
  const state = globalThis.__supabaseMock
  const isAdmin = key === 'service-role-key'
  const authHeader = options.global?.headers?.Authorization ?? ''
  return {
    auth: {
      getUser: async (token) => {
        const user = state.users[token]
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid' } }
      },
    },
    from: (table) => {
      if (!isAdmin && !state.users[authHeader.replace(/^Bearer\s+/i, '')]) throw new Error('user client without session')
      return query(table, state)
    },
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args, isAdmin })
      return state.rpcResult ?? { data: { sent_at: '2026-10-06T00:00:00Z' }, error: null }
    },
  }
}
