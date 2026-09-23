import { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { LoadingScreen } from './LoadingScreen'

type Props = {
  role: 'admin' | 'shop_user'
  children: ReactNode
}

export default function ProtectedRoute({ role, children }: Props) {
  const { user, profile, loading } = useAuth()

  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  if (profile?.role !== role) {
    return <Navigate to={profile?.role === 'admin' ? '/admin' : '/dashboard'} replace />
  }
  return <>{children}</>
}
