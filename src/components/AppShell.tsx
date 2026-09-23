import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { LogOut, LayoutDashboard, Users, Shield, Car, Menu, X } from 'lucide-react'

export default function AppShell() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const isAdmin = profile?.role === 'admin'
  const [shopLogo, setShopLogo] = useState<string | null>(null)
  const [shopName, setShopName] = useState<string | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (isAdmin || !profile?.shop_id) return
    supabase.from('shops').select('name, logo_url').eq('id', profile.shop_id).maybeSingle()
      .then(({ data }) => {
        setShopName(data?.name ?? null)
        setShopLogo(data?.logo_url ?? null)
      })
  }, [isAdmin, profile?.shop_id])

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const navItems = isAdmin
    ? [
        { label: 'Shops', path: '/admin', icon: Users },
        { label: 'Vehicle Templates', path: '/admin/templates', icon: Car },
      ]
    : [
        { label: 'Leads', path: '/dashboard', icon: LayoutDashboard },
        { label: 'Vehicles', path: '/dashboard/vehicles', icon: Car },
      ]

  const isActive = (path: string) =>
    path === '/admin'
      ? location.pathname === '/admin'
      : path === '/dashboard'
        ? location.pathname === '/dashboard'
        : location.pathname.startsWith(path)

  const activeItem = navItems.find((item) => isActive(item.path))
  const headerTitle = activeItem?.label ?? (isAdmin ? 'Admin Console' : 'Dashboard')
  const badgeLabel = isAdmin ? 'Admin Console' : shopName ?? 'Shop CRM'

  const initial = profile?.full_name?.[0]?.toUpperCase() ?? profile?.email?.[0]?.toUpperCase() ?? '?'

  const navigateTo = (path: string) => {
    setMobileNavOpen(false)
    navigate(path)
  }

  return (
    <div className="dark-surface bg-obsidian-950 min-h-screen text-slate-100 flex">
      {/* Mobile drawer backdrop */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`bg-obsidian-900/95 lg:bg-obsidian-900/90 backdrop-blur-md border-r border-white/10 w-64 flex flex-col justify-between flex-shrink-0 fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 lg:static lg:translate-x-0 lg:min-h-screen ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={() => setMobileNavOpen(false)}
          className="lg:hidden absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
        <div>
          <div className="px-6 py-5 border-b border-white/5">
            <div className="flex items-center gap-2.5">
              {!isAdmin && shopLogo ? (
                <img src={shopLogo} alt={shopName ?? 'Shop logo'} className="h-8 w-auto max-w-[140px] object-contain rounded" />
              ) : (
                <>
                  <div className="w-9 h-9 bg-cobalt-600 rounded-xl flex items-center justify-center shadow-glow-blue ring-1 ring-white/10">
                    <Shield size={18} className="text-white" />
                  </div>
                  <span className="font-bold text-lg tracking-tight text-white">{isAdmin ? 'SpecPlus' : shopName ?? 'SpecPlus'}</span>
                </>
              )}
            </div>
            <div className="mt-3">
              <span className="inline-block px-3 py-1 text-xs font-semibold tracking-wider text-cobalt-400 bg-cobalt-500/10 border border-cobalt-500/20 rounded-full">
                {badgeLabel}
              </span>
            </div>
          </div>

          <nav className="py-4 px-3 space-y-1">
            {navItems.map((item) => (
              <button
                key={item.path}
                onClick={() => navigateTo(item.path)}
                className={
                  isActive(item.path)
                    ? 'w-full flex items-center gap-3 bg-cobalt-500/10 text-cobalt-400 border-l-2 border-cobalt-500 font-semibold px-3 py-2.5 rounded-r-xl text-sm shadow-glow-blue transition-colors'
                    : 'w-full flex items-center gap-3 text-slate-400 hover:text-white hover:bg-white/5 rounded-xl px-3 py-2.5 font-medium text-sm transition-colors'
                }
              >
                <item.icon size={18} />
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 bg-white/10 ring-1 ring-white/10 rounded-full flex items-center justify-center text-sm font-semibold text-slate-200">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate text-slate-300">{profile?.full_name || 'User'}</p>
              <p className="text-xs text-slate-500 truncate">{profile?.email}</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 max-h-screen overflow-hidden">
        <header className="bg-obsidian-900/60 backdrop-blur-md border-b border-white/5 px-4 sm:px-8 py-4 flex items-center justify-between sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden w-9 h-9 flex items-center justify-center rounded-lg text-slate-300 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-bold tracking-tight text-white leading-tight truncate">{headerTitle}</h1>
              <p className="text-xs text-slate-500 truncate">{isAdmin ? 'SpecPlus Admin' : shopName ?? 'SpecPlus'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium text-slate-200 leading-tight">{profile?.full_name || 'User'}</p>
              <p className="text-xs text-slate-500">{isAdmin ? 'Administrator' : 'Shop Owner'}</p>
            </div>
            <div className="w-9 h-9 bg-cobalt-500/15 ring-1 ring-cobalt-500/30 rounded-full flex items-center justify-center text-sm font-semibold text-cobalt-300">
              {initial}
            </div>
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto bg-obsidian-950 text-slate-100 flex flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
