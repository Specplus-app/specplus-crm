import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
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
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/AppShell'

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/lead/:shopId" element={<PublicLeadForm />} />
      <Route path="/customize/:shopId" element={<CustomerCustomizer />} />
      <Route path="/embed/vehicle/:vehicleId" element={<VehicleEmbed />} />
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
