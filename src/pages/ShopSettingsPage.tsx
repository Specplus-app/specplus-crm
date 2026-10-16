import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Building2, Check, Copy, ExternalLink, Image as ImageIcon, Link2, Mail, Phone, Settings, Trash2, Upload } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { useShopBilling } from '../lib/billing'
import { supabase } from '../lib/supabase'
import { LoadingScreen } from '../components/LoadingScreen'
import { copyText, customerLinkFor, publicQuoteOrigin } from '../lib/customerLink'
import { removeShopLogo, uploadShopLogo, type LogoResult } from '../lib/shopLogo'

type ShopDetails = {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  contact_email: string | null
  phone: string | null
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'ready'; shop: ShopDetails }

const PUBLIC_QUOTE_ORIGIN = publicQuoteOrigin(import.meta.env.VITE_PUBLIC_QUOTE_ORIGIN)

const card = 'bg-obsidian-900/50 border border-white/10 rounded-2xl p-4 sm:p-5'

export default function ShopSettingsPage() {
  const { profile, profileLoading } = useAuth()
  const shopId = profile?.shop_id ?? null
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    if (!shopId) return
    const id = ++loadSeq.current
    setState({ status: 'loading' })
    try {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, slug, logo_url, contact_email, phone')
        .eq('id', shopId)
        .maybeSingle()
      if (id !== loadSeq.current) return
      if (error) setState({ status: 'error', message: error.message })
      else if (!data) setState({ status: 'missing' })
      else setState({ status: 'ready', shop: data as ShopDetails })
    } catch (err) {
      if (id !== loadSeq.current) return
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' })
    }
  }, [shopId])

  useEffect(() => {
    load()
  }, [load])

  if (profileLoading || !profile) return <LoadingScreen />

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Settings size={22} className="text-cobalt-400" /> Settings
          </h1>
          <p className="text-sm text-slate-400 mt-1">Your shop details and the link customers use to request quotes.</p>
        </div>

        {!shopId || state.status === 'missing' ? (
          <div className={`${card} text-center`}>
            <Building2 size={24} className="mx-auto text-slate-500 mb-2" />
            <p className="text-sm font-medium text-slate-200">No shop is linked to your account</p>
            <p className="text-xs text-slate-500 mt-1">Reach out to your SpecPlus administrator to finish setting up your shop.</p>
          </div>
        ) : state.status === 'loading' ? (
          <div className="space-y-5" aria-busy="true">
            <div className="h-40 bg-white/5 rounded-2xl animate-pulse" />
            <div className="h-36 bg-white/5 rounded-2xl animate-pulse" />
          </div>
        ) : state.status === 'error' ? (
          <div className="flex items-start justify-between gap-3 text-sm text-red-200 bg-red-500/10 border border-red-500/30 rounded-2xl px-4 py-3" role="alert">
            <span className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span>Could not load your shop settings: {state.message}</span>
            </span>
            <button onClick={load} className="font-medium underline flex-shrink-0">Retry</button>
          </div>
        ) : (
          <>
            <ShopDetailsCard
              shop={state.shop}
              onLogoChange={(logoUrl) => setState((s) => (s.status === 'ready' ? { ...s, shop: { ...s.shop, logo_url: logoUrl } } : s))}
            />
            <QuoteRequestsCard link={customerLinkFor(PUBLIC_QUOTE_ORIGIN, state.shop)} />
          </>
        )}
      </div>
    </div>
  )
}

function ShopDetailsCard({ shop, onLogoChange }: { shop: ShopDetails; onLogoChange: (logoUrl: string | null) => void }) {
  return (
    <section className={card}>
      <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
        <Building2 size={16} className="text-cobalt-400" /> Shop details
      </h2>
      <div className="mt-4 flex flex-col sm:flex-row gap-5">
        <ShopLogo shop={shop} onLogoChange={onLogoChange} />
        <dl className="min-w-0 flex-1 grid gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Shop name</dt>
            <dd className="text-slate-100 font-medium break-words">{shop.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 flex items-center gap-1"><Mail size={12} /> Contact email</dt>
            <dd className="text-slate-200 break-all">{shop.contact_email?.trim() || <span className="text-slate-500">Not provided</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 flex items-center gap-1"><Phone size={12} /> Phone</dt>
            <dd className="text-slate-200">{shop.phone?.trim() || <span className="text-slate-500">Not provided</span>}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

// Logo with the upload controls moved from Vehicles (same validation,
// storage and permissions; see lib/shopLogo).
function ShopLogo({ shop, onLogoChange }: { shop: ShopDetails; onLogoChange: (logoUrl: string | null) => void }) {
  const { readOnly } = useShopBilling()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showLogo = Boolean(shop.logo_url) && failedUrl !== shop.logo_url

  const run = async (action: () => Promise<LogoResult>) => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (result.ok) onLogoChange(result.logoUrl)
      else setError(result.error)
    } catch {
      setError('Upload failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sm:w-44 flex-shrink-0">
      <div className="w-28 h-28 rounded-xl bg-obsidian-950/80 border border-white/10 flex items-center justify-center overflow-hidden">
        {showLogo ? (
          <img src={shop.logo_url!} alt={`${shop.name} logo`} className="w-full h-full object-contain" onError={() => setFailedUrl(shop.logo_url)} />
        ) : (
          <span className="flex flex-col items-center gap-1 text-[11px] text-slate-500">
            <ImageIcon size={24} className="text-slate-600" /> No logo
          </span>
        )}
      </div>
      {readOnly ? (
        <p className="text-xs text-slate-500 mt-2">Your trial has expired. Upgrade to change your logo.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <label
            className={`flex items-center gap-2 text-sm font-medium rounded-lg px-3 py-2 transition-colors ${
              busy ? 'bg-white/5 text-slate-500 cursor-not-allowed' : 'bg-cobalt-600 hover:bg-cobalt-500 text-white cursor-pointer'
            }`}
          >
            <Upload size={14} />
            {busy ? 'Saving…' : shop.logo_url ? 'Replace logo' : 'Upload logo'}
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) run(() => uploadShopLogo(supabase, shop.id, file))
              }}
            />
          </label>
          {shop.logo_url && !busy && (
            <button
              onClick={() => run(() => removeShopLogo(supabase, shop.id))}
              className="flex items-center gap-1.5 text-sm font-medium text-red-300 hover:text-red-200 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg px-3 py-2 transition-colors"
            >
              <Trash2 size={14} />
              Remove
            </button>
          )}
        </div>
      )}
      <p className="text-[11px] text-slate-500 mt-2">PNG or JPG, up to 3 MB. A transparent PNG looks best. Shown on your customer building page and in your dashboard.</p>
      {error && <p className="text-xs text-red-300 mt-1" role="alert">{error}</p>}
    </div>
  )
}

function QuoteRequestsCard({ link }: { link: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<number>()

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copyLink = async () => {
    const ok = await copyText(link, {
      writeText: navigator.clipboard?.writeText ? (text) => navigator.clipboard.writeText(text) : undefined,
      fallbackCopy: () => {
        inputRef.current?.select()
        return document.execCommand('copy')
      },
    })
    setCopy(ok ? 'copied' : 'failed')
    if (!ok) inputRef.current?.select()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopy('idle'), ok ? 2000 : 6000)
  }

  return (
    <section className={card}>
      <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
        <Link2 size={16} className="text-cobalt-400" /> Quote requests
      </h2>
      <p className="text-xs text-slate-400 mt-1 mb-3">
        Share this link with customers so they can build a quote. It opens your vehicle customizer.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={link}
          aria-label="Customer quote request link"
          onFocus={(e) => e.target.select()}
          className="min-w-0 flex-1 bg-obsidian-950/80 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-300 font-mono focus:outline-none focus:border-cobalt-500/50"
        />
        <div className="flex gap-2">
          <button
            onClick={copyLink}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-cobalt-600 hover:bg-cobalt-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            {copy === 'copied' ? <Check size={16} /> : <Copy size={16} />}
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </button>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-obsidian-900/60 border border-white/10 hover:bg-white/5 text-slate-300 text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            <ExternalLink size={16} />
            Open
          </a>
        </div>
      </div>
      <p className="text-xs mt-2 min-h-[1rem]" aria-live="polite">
        {copy === 'copied' && <span className="text-emerald-300">Link copied to your clipboard.</span>}
        {copy === 'failed' && <span className="text-amber-200">Couldn't copy automatically. The link is selected — copy it from the box.</span>}
      </p>
    </section>
  )
}
