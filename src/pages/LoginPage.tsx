import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Mail, Lock, Eye, EyeOff, AlertCircle, User, Building2 } from 'lucide-react'

type Props = { mode?: 'signin' | 'signup' }

export default function LoginPage({ mode = 'signin' }: Props) {
  const { signIn, signUp, user, profile, loading } = useAuth()
  const navigate = useNavigate()
  const isSignUp = mode === 'signup'
  const [fullName, setFullName] = useState('')
  const [shopName, setShopName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!loading && user && profile) {
      if (profile.role === 'admin') {
        navigate('/admin', { replace: true })
      } else {
        navigate('/dashboard', { replace: true, state: isSignUp ? { welcome: true } : undefined })
      }
    }
  }, [loading, user, profile, navigate, isSignUp])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const result = isSignUp
      ? await signUp(fullName.trim(), shopName.trim(), email.trim(), password)
      : await signIn(email.trim(), password)
    if (result.error) {
      setError(result.error)
      setSubmitting(false)
    }
    // onAuthStateChange + the effect above handle navigation on success.
  }

  const inputClass =
    'w-full bg-obsidian-950 border border-white/10 text-white text-sm rounded-lg pl-10 pr-3 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 transition-colors placeholder:text-zinc-600'

  return (
    <div className="dark-surface min-h-screen bg-obsidian-950 bg-radial-spotlight flex items-center justify-center px-4 py-10">
      {/* Background accent */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-brand-800/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <img
            src="/Spec_Plus_Logo.png"
            alt="SpecPlus"
            className="h-28 sm:h-32 w-auto max-w-full object-contain mb-3 drop-shadow-lg"
          />
          <h1 className="sr-only">SpecPlus CRM</h1>
          <p className="text-sm text-zinc-500 text-center">
            {isSignUp ? 'Create your shop account to start managing leads' : 'Sign in to manage your shop leads'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-obsidian-900/50 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card p-8 w-full max-w-md relative z-10 space-y-5 animate-scale-in">
          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-1 bg-obsidian-950 border border-white/10 rounded-lg p-1">
            <button
              type="button"
              onClick={() => navigate('/login')}
              className={`text-sm font-semibold rounded-md py-2 transition-colors ${!isSignUp ? 'bg-metallic-gradient text-white shadow-glow-blue' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => navigate('/signup')}
              className={`text-sm font-semibold rounded-md py-2 transition-colors ${isSignUp ? 'bg-metallic-gradient text-white shadow-glow-blue' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Create Account
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-950/50 border border-red-800 text-red-300 text-sm rounded-lg px-3 py-2.5 animate-fade-in">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {isSignUp && (
            <>
              <div>
                <label htmlFor="fullName" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Full Name
                </label>
                <div className="relative">
                  <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    autoFocus
                    className={inputClass}
                    placeholder="Jane Smith"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="shopName" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Shop / Business Name
                </label>
                <div className="relative">
                  <Building2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    id="shopName"
                    type="text"
                    value={shopName}
                    onChange={(e) => setShopName(e.target.value)}
                    required
                    className={inputClass}
                    placeholder="Precision Auto Body"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label htmlFor="email" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Email
            </label>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus={!isSignUp}
                className={inputClass}
                placeholder="you@shop.com"
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Password
            </label>
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="w-full bg-obsidian-950 border border-white/10 text-white text-sm rounded-lg pl-10 pr-10 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 transition-colors placeholder:text-zinc-600"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {isSignUp && <p className="text-xs text-zinc-600 mt-2">At least 6 characters.</p>}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-metallic-gradient text-white font-bold tracking-wide shadow-glow-blue hover:brightness-110 border border-white/10 border-t-white/30 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed text-sm py-2.5 transition-all"
          >
            {submitting
              ? (isSignUp ? 'Creating account…' : 'Signing in…')
              : (isSignUp ? 'Create Account' : 'Sign in')}
          </button>
        </form>

        <p className="text-center text-xs text-zinc-600 mt-6">
          {isSignUp ? (
            <>Already have an account?{' '}
              <button onClick={() => navigate('/login')} className="text-brand-400 hover:text-brand-300 font-medium">Sign in</button>
            </>
          ) : (
            <>New to SpecPlus?{' '}
              <button onClick={() => navigate('/signup')} className="text-brand-400 hover:text-brand-300 font-medium">Create an account</button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
