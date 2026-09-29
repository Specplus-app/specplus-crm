import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { Session, User } from '@supabase/supabase-js'
import { supabase, Profile } from './supabase'

type AuthContextValue = {
  session: Session | null
  user: User | null
  profile: Profile | null
  loading: boolean
  profileLoading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signUp: (fullName: string, shopName: string, email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)

  const loadProfile = useCallback(async (uid: string) => {
    setProfileLoading(true)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', uid)
        .maybeSingle()
      if (error) {
        console.error('Failed to load profile:', error.message)
        return
      }
      setProfile(data as Profile | null)
    } finally {
      setProfileLoading(false)
    }
  }, [])

  const finishPendingShopSetup = useCallback(async (
    authUser: User,
    accessToken: string,
    requestedShopName?: string,
    requestedFullName?: string,
  ): Promise<string | null> => {
    const metadataShopName = typeof authUser.user_metadata?.shop_name === 'string'
      ? authUser.user_metadata.shop_name.trim()
      : ''
    const metadataFullName = typeof authUser.user_metadata?.full_name === 'string'
      ? authUser.user_metadata.full_name.trim()
      : ''
    const shopName = requestedShopName?.trim() || metadataShopName
    const fullName = requestedFullName?.trim() || metadataFullName

    // Accounts created by an admin (and the admin account itself) do not carry
    // self-signup shop metadata, so there is nothing to finish for them.
    if (!shopName) return null

    // The service-role edge function can inspect the profile even while shop_id is
    // NULL. The browser cannot reliably do that because production profile RLS is
    // intentionally scoped to admins and users already attached to a shop.
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signup-shop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: fullName, shop_name: shopName }),
    })

    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      return detail?.error ?? `Could not finish setting up your shop (${res.status}).`
    }

    return null
  }, [])

  const refreshProfile = useCallback(async () => {
    if (user?.id) await loadProfile(user.id)
  }, [user?.id, loadProfile])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user?.id) {
        loadProfile(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user?.id) {
        const uid = session.user.id
        // Defer the Supabase call so it does not run inside the auth callback
        // (calling supabase directly here can deadlock the client).
        setTimeout(() => { loadProfile(uid) }, 0)
      } else {
        setProfile(null)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [loadProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { error: error.message }
    if (!data.session || !data.user) return { error: 'Signed in, but no active session was returned. Please try again.' }

    // For self-signups that required email verification, the initial sign-up had
    // no session and could not call signup-shop. Complete that idempotent step now
    // before loading the profile so production RLS can see the attached shop.
    const setupError = await finishPendingShopSetup(data.user, data.session.access_token)
    if (setupError) {
      await supabase.auth.signOut()
      setProfile(null)
      return { error: setupError }
    }

    await loadProfile(data.user.id)
    return { error: null }
  }, [finishPendingShopSetup, loadProfile])

  const signUp = useCallback(async (fullName: string, shopName: string, email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, shop_name: shopName } },
    })
    if (error) return { error: error.message }
    const token = data.session?.access_token
    if (!token) return { error: 'Account created. Check your email to verify your address, then sign in.' }

    // A brand-new shop_user cannot insert a shop directly (RLS restricts shop
    // creation to admins), so a service-role edge function creates the shop and
    // links it to this profile. The same helper runs after email verification.
    const setupError = await finishPendingShopSetup(data.user, token, shopName, fullName)
    if (setupError) return { error: setupError }
    await loadProfile(data.user.id)
    return { error: null }
  }, [finishPendingShopSetup, loadProfile])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  return (
    <AuthContext.Provider value={{ session, user, profile, loading, profileLoading, signIn, signUp, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
