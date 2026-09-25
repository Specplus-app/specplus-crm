import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import LoginPage from './pages/LoginPage'
import ShopDashboard from './pages/ShopDashboard'
import LeadDetailPage from './pages/LeadDetailPage'
import AdminDashboard from './pages/AdminDashboard'
import AdminShopDetail from './pages/AdminShopDetail'
import AdminTemplates from './pages/AdminTemplates'
import PublicLeadForm from './pages/PublicLeadForm'
import ShopVehicles from './pages/ShopVehicles'
import VehicleBuilder from './pages/VehicleBuilder'
import CustomerCustomizer from './pages/CustomerCustomizer'
import VehicleEmbed from './pages/VehicleEmbed'
import BuildSheet from './pages/BuildSheet'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/AppShell'
import { LoadingScreen } from './components/LoadingScreen'

function AppRoutes() {
  const { loading } = useAuth()

  // While the session and profile are still resolving, show a centered spinner
  // instead of rendering routes against not-yet-loaded user data.
  if (loading) return <LoadingScreen />

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/lead/:shopId" element={<PublicLeadForm />} />
      <Route path="/customize/:shopId" element={<CustomerCustomizer />} />
      <Route path="/embed/vehicle/:vehicleId" element={<VehicleEmbed />} />
      <Route path="/build/:id" element={<BuildSheet />} />
      <Route
        path="/admin"
        element={
          <ProtectedRoute role="admin">
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<AdminDashboard />} />
        <Route path="shops/:shopId" element={<AdminShopDetail />} />
        <Route path="templates" element={<AdminTemplates />} />
        <Route path="templates/:vehicleId" element={<VehicleBuilder />} />
      </Route>
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute role="shop_user">
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<ShopDashboard />} />
        <Route path="leads/:leadId" element={<LeadDetailPage />} />
        <Route path="vehicles" element={<ShopVehicles />} />
        <Route path="vehicles/:vehicleId" element={<VehicleBuilder />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
