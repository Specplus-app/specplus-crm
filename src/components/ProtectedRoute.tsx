import { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { LoadingScreen } from './LoadingScreen'

type Props = {
  role: 'admin' | 'shop_user'
  children: ReactNode
}

export default function ProtectedRoute({ role, children }: Props) {
  const { user, profile, loading, profileLoading } = useAuth()
  const location = useLocation()

  if (loading || profileLoading) return <LoadingScreen />
  // Remember where they were going (e.g. a lead opened from a notification)
  // so signing in continues there.
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  // Signed in but the profile row is not available yet: show the spinner
  // rather than redirecting, which would otherwise loop back onto this route.
  if (!profile) return <LoadingScreen />
  if (profile?.role !== role) {
    return <Navigate to={profile?.role === 'admin' ? '/admin' : '/dashboard'} replace />
  }
  return <>{children}</>
}
