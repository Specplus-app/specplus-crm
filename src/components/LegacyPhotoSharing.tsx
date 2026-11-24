import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { STAFF_PHOTO_ACCESS, useCustomerPhotos } from '../lib/customerPhotos'
import { AlertTriangle, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react'

type LegacyPhoto = { path: string; shared: boolean; shared_at: string | null; other_requests: number }

// Photos uploaded before photos were tied to their request are staff-only:
// customers do not see them on quote or build-sheet links. Staff can show one
// to this request's customer after confirming it is theirs.
export default function LegacyPhotoSharing({ leadId }: { leadId: string }) {
  const [photos, setPhotos] = useState<LegacyPhoto[]>([])
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const photoUrl = useCustomerPhotos(photos.map((p) => p.path), STAFF_PHOTO_ACCESS)

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('lead_legacy_photos', { p_lead_id: leadId })
    if (rpcError) { setPhotos([]); return }
    setPhotos(Array.isArray(data) ? (data as LegacyPhoto[]) : [])
  }, [leadId])

  useEffect(() => { load() }, [load])

  if (photos.length === 0) return null

  const share = async (photo: LegacyPhoto) => {
    const warning = photo.other_requests > 0
      ? `\n\nWarning: ${photo.other_requests} other request(s) also reference this photo. It may not belong to this customer.`
      : ''
    if (!window.confirm(
      `Show this photo to this request's customer on their quote and build-sheet links?\n\n` +
      `Only do this after confirming with the customer (for example by phone, or a reply from the email address on this request) that the photo is theirs.${warning}`,
    )) return
    setBusyPath(photo.path)
    setError(null)
    const { error: rpcError } = await supabase.rpc('share_legacy_customer_photo', { p_lead_id: leadId, p_path: photo.path })
    setBusyPath(null)
    if (rpcError) { setError('Could not share the photo. Please try again.'); return }
    await load()
  }

  const unshare = async (photo: LegacyPhoto) => {
    setBusyPath(photo.path)
    setError(null)
    const { error: rpcError } = await supabase.rpc('unshare_legacy_customer_photo', { p_lead_id: leadId, p_path: photo.path })
    setBusyPath(null)
    if (rpcError) { setError('Could not update the photo. Please try again.'); return }
    await load()
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
      <h2 className="text-sm font-semibold text-zinc-900 mb-1 flex items-center gap-2">
        <ShieldCheck size={16} className="text-zinc-400" />
        Older customer photos
      </h2>
      <p className="text-xs text-zinc-500 mb-3">
        These photos were uploaded before photos were tied to their request, so the customer does not see them on
        their quote or build-sheet links. Show one only after confirming with the customer that it is theirs.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {photos.map((photo) => {
          const url = photoUrl(photo.path)
          return (
            <div key={photo.path} className="border border-zinc-200 rounded-lg overflow-hidden">
              {url ? (
                <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Customer photo" className="w-full h-24 object-cover" /></a>
              ) : (
                <div className="w-full h-24 bg-zinc-100" />
              )}
              <div className="p-2 space-y-1">
                <p className={`text-[11px] font-medium ${photo.shared ? 'text-emerald-700' : 'text-zinc-500'}`}>
                  {photo.shared ? 'Shown to customer' : 'Staff only'}
                </p>
                {photo.other_requests > 0 && (
                  <p className="text-[11px] text-amber-700 flex items-center gap-1">
                    <AlertTriangle size={11} /> Also on {photo.other_requests} other request{photo.other_requests === 1 ? '' : 's'}
                  </p>
                )}
                <button
                  onClick={() => (photo.shared ? unshare(photo) : share(photo))}
                  disabled={busyPath === photo.path}
                  className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline disabled:opacity-50"
                >
                  {busyPath === photo.path ? <Loader2 size={11} className="animate-spin" /> : photo.shared ? <EyeOff size={11} /> : <Eye size={11} />}
                  {photo.shared ? 'Stop showing' : 'Show to customer'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}
