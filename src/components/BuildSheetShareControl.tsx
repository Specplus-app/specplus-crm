import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildSheetShareUrl } from '../lib/buildSheetShare'
import { Check, Copy, FileText, Link2Off, Loader2, RefreshCw } from 'lucide-react'

type SheetRow = { id: string; share_token: string | null; shared_at: string | null }

// Build sheets saved before share links existed were readable by anyone, so
// their old /build/<id> links are retired. Staff issue (or rotate) a scoped
// share link here; only the holder of that link can open the sheet.
export default function BuildSheetShareControl({ leadId, readOnly }: { leadId: string; readOnly: boolean }) {
  const [sheet, setSheet] = useState<SheetRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('build_sheets')
      .select('id, share_token, shared_at')
      .eq('lead_id', leadId)
      .maybeSingle()
    setSheet((data as SheetRow | null) ?? null)
  }, [leadId])

  useEffect(() => { load() }, [load])

  if (!sheet) return null

  const url = sheet.share_token ? buildSheetShareUrl(sheet.share_token) : null

  const createLink = async () => {
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('create_build_sheet_share_link', { p_sheet_id: sheet.id })
    setBusy(false)
    if (rpcError) { setError('Could not create a share link. Please try again.'); return }
    await load()
  }

  const revokeLink = async () => {
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('revoke_build_sheet_share_link', { p_sheet_id: sheet.id })
    setBusy(false)
    if (rpcError) { setError('Could not turn off the link. Please try again.'); return }
    await load()
  }

  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copy failed. Select the link and copy it manually.')
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
      <h2 className="text-sm font-semibold text-zinc-900 mb-1 flex items-center gap-2">
        <FileText size={16} className="text-zinc-400" />
        Build sheet link
      </h2>
      {url ? (
        <>
          <p className="text-xs text-zinc-500 mb-3">Anyone with this link can view the build sheet. Older build sheet links no longer work.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={url} className="flex-1 min-w-0 text-xs border border-zinc-200 rounded-lg px-2 py-1.5 text-zinc-700 bg-zinc-50" onFocus={(e) => e.currentTarget.select()} />
            <button onClick={copy} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="flex items-center gap-4 mt-3">
            {!readOnly && (
              <button onClick={createLink} disabled={busy} className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 disabled:opacity-50">
                <RefreshCw size={12} /> Replace link
              </button>
            )}
            <button onClick={revokeLink} disabled={busy} className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 disabled:opacity-50">
              <Link2Off size={12} /> Turn off link
            </button>
            {busy && <Loader2 size={12} className="animate-spin text-zinc-400" />}
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-500 mb-3">This build sheet is not shared. Links sent before share links existed no longer work; create a new link to share it again.</p>
          {!readOnly && (
            <button onClick={createLink} disabled={busy} className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg px-3 py-1.5 disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />} Create share link
            </button>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}
