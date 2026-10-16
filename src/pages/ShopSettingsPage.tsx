import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Building2, Check, Copy, ExternalLink, Image as ImageIcon, Link2, Mail, Pencil, Phone, Settings, Trash2, Upload } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { useShopBilling } from '../lib/billing'
import { supabase } from '../lib/supabase'
import { LoadingScreen } from '../components/LoadingScreen'
import { copyText, customerLinkFor, publicQuoteOrigin } from '../lib/customerLink'
import { removeShopLogo, uploadShopLogo, type LogoResult } from '../lib/shopLogo'
import {
  EMAIL_MAX, NAME_MAX, PHONE_MAX, announceShopDetailsChange, changedFields, draftFrom, validateShopDetails, type ShopDetailsDraft,
} from '../lib/shopDetails'

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
              onSaved={(shop) => setState({ status: 'ready', shop })}
            />
            <QuoteRequestsCard link={customerLinkFor(PUBLIC_QUOTE_ORIGIN, state.shop)} />
          </>
        )}
      </div>
    </div>
  )
}

const SHOP_FIELDS = 'id, name, slug, logo_url, contact_email, phone'
const inputClass = 'w-full bg-obsidian-950/80 border rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-cobalt-500/60 placeholder:text-slate-600'

function ShopDetailsCard({ shop, onLogoChange, onSaved }: {
  shop: ShopDetails
  onLogoChange: (logoUrl: string | null) => void
  onSaved: (shop: ShopDetails) => void
}) {
  const { readOnly } = useShopBilling()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ShopDetailsDraft>(() => draftFrom(shop))
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<number>()
  useEffect(() => () => window.clearTimeout(savedTimer.current), [])

  const original = draftFrom(shop)
  const errors = validateShopDetails(draft)
  const changes = changedFields(original, draft)
  const hasChanges = Object.keys(changes).length > 0
  const valid = Object.keys(errors).length === 0

  const startEdit = () => {
    setDraft(draftFrom(shop))
    setTouched(false)
    setSaveError(null)
    setSaved(false)
    setEditing(true)
  }
  const cancel = () => {
    setDraft(draftFrom(shop))
    setSaveError(null)
    setEditing(false)
  }
  const save = async () => {
    setTouched(true)
    if (!valid || !hasChanges || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      // Only the edited columns; reading the row back confirms RLS really
      // applied the update (a blocked update returns no row, not an error).
      const { data, error } = await supabase.from('shops').update(changes).eq('id', shop.id).select(SHOP_FIELDS).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) throw new Error('Your changes were not saved. Please try again.')
      const next = data as ShopDetails
      onSaved(next)
      announceShopDetailsChange({ shopId: next.id, name: next.name })
      setEditing(false)
      setSaved(true)
      window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save your changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const field = (key: keyof ShopDetailsDraft) => ({
    value: draft[key],
    disabled: saving,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.value })),
    onBlur: () => setTouched(true),
    'aria-invalid': touched && errors[key] ? true : undefined,
    className: `${inputClass} ${touched && errors[key] ? 'border-red-500/50' : 'border-white/10'}`,
  })
  const fieldError = (key: keyof ShopDetailsDraft) =>
    touched && errors[key] ? <p className="text-xs text-red-300 mt-1">{errors[key]}</p> : null

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
          <Building2 size={16} className="text-cobalt-400" /> Shop details
        </h2>
        {!editing && !readOnly && (
          <button onClick={startEdit} className="flex items-center gap-1.5 text-sm font-medium text-slate-200 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 transition-colors">
            <Pencil size={14} /> Edit
          </button>
        )}
      </div>
      <div className="mt-4 flex flex-col sm:flex-row gap-5">
        <ShopLogo shop={shop} onLogoChange={onLogoChange} />
        {editing ? (
          <form
            className="min-w-0 flex-1 grid gap-3 text-sm"
            noValidate
            onSubmit={(e) => { e.preventDefault(); save() }}
          >
            <label className="block">
              <span className="text-xs text-slate-500">Shop name</span>
              <input {...field('name')} type="text" autoComplete="organization" maxLength={NAME_MAX} required />
              {fieldError('name')}
            </label>
            <label className="block">
              <span className="text-xs text-slate-500 flex items-center gap-1"><Mail size={12} /> Contact email</span>
              <input {...field('contact_email')} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={EMAIL_MAX} required />
              {fieldError('contact_email')}
              <span className="block text-[11px] text-slate-500 mt-1">New-request and customer-message notification emails are sent here.</span>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500 flex items-center gap-1"><Phone size={12} /> Phone <span className="text-slate-600">(optional)</span></span>
              <input {...field('phone')} type="tel" inputMode="tel" autoComplete="tel" maxLength={PHONE_MAX} />
              {fieldError('phone')}
            </label>
            {saveError && (
              <p className="flex items-start gap-2 text-xs text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" role="alert">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {saveError}
              </p>
            )}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <button type="button" onClick={cancel} disabled={saving} className="flex items-center justify-center text-sm font-medium text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-4 py-2.5 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={saving || !hasChanges || (touched && !valid)} className="flex items-center justify-center gap-2 text-sm font-semibold text-white bg-cobalt-600 hover:bg-cobalt-500 rounded-lg px-4 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        ) : (
          <dl className="min-w-0 flex-1 grid gap-3 text-sm content-start">
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
            {saved && <p className="text-xs text-emerald-300" aria-live="polite">Shop details saved.</p>}
            {readOnly && <p className="text-xs text-slate-500">Your trial has expired. Upgrade to change your shop details.</p>}
          </dl>
        )}
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
