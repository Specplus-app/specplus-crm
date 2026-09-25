import { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { LoadingScreen } from './LoadingScreen'

type Props = {
  role: 'admin' | 'shop_user'
  children: ReactNode
}

export default function ProtectedRoute({ role, children }: Props) {
  const { user, profile, loading, profileLoading } = useAuth()

  if (loading || profileLoading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  // Signed in but the profile row is not available yet: show the spinner
  // rather than redirecting, which would otherwise loop back onto this route.
  if (!profile) return <LoadingScreen />
  if (profile?.role !== role) {
    return <Navigate to={profile?.role === 'admin' ? '/admin' : '/dashboard'} replace />
  }
  return <>{children}</>
}
