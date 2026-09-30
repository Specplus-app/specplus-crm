import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import CustomerCustomizer from './CustomerCustomizer'

export default function PublicQuotePage() {
  const { shopSlug } = useParams<{ shopSlug: string }>()
  const [shopId, setShopId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!shopSlug) {
      setShopId(null)
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    supabase
      .from('shops')
      .select('id')
      .eq('slug', shopSlug.toLowerCase())
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) console.error('Failed to resolve shop slug:', error.message)
        setShopId(data?.id ?? null)
        setLoading(false)
      })

    return () => { active = false }
  }, [shopSlug])

  if (loading) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight">
        <div className="w-9 h-9 border-[3px] border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!shopId) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-lg font-medium">Shop not found</p>
        </div>
      </div>
    )
  }

  return <CustomerCustomizer shopIdOverride={shopId} />
}
