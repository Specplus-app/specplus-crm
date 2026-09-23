import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, Vehicle, formatDate } from '../lib/supabase'
import { Plus, Car, Edit3, Trash2, X, LayoutTemplate } from 'lucide-react'

type TemplateWithParts = Vehicle & { part_count?: number }

export default function AdminTemplates() {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState<TemplateWithParts[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)

  const loadTemplates = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('is_template', true)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('Failed to load templates:', error.message)
    } else {
      const list = data as Vehicle[]
      const withCounts = await Promise.all(
        list.map(async (v) => {
          const { count } = await supabase
            .from('vehicle_parts')
            .select('*', { count: 'exact', head: true })
            .eq('vehicle_id', v.id)
          return { ...v, part_count: count ?? 0 }
        })
      )
      setTemplates(withCounts)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  const handleDelete = async (template: Vehicle) => {
    if (!confirm(`Delete the "${template.name}" template? Copies already pushed to shops are not affected.`)) return
    if (template.front_image_path) {
      await supabase.storage.from('vehicles').remove([template.front_image_path])
    }
    if (template.rear_image_path) {
      await supabase.storage.from('vehicles').remove([template.rear_image_path])
    }
    const { error } = await supabase.from('vehicles').delete().eq('id', template.id)
    if (error) {
      console.error('Failed to delete:', error.message)
    } else {
      setTemplates((prev) => prev.filter((v) => v.id !== template.id))
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">Vehicle Templates</h1>
            <p className="text-sm text-zinc-500 mt-1">Build a vehicle once, then push it to shops so they only fill in pricing</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            <Plus size={16} />
            New Template
          </button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-zinc-200 p-4 animate-pulse">
                <div className="h-5 bg-zinc-100 rounded w-1/4 mb-3" />
                <div className="h-3 bg-zinc-100 rounded w-1/3" />
              </div>
            ))}
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-16">
            <LayoutTemplate size={40} className="mx-auto text-zinc-300 mb-3" />
            <p className="text-zinc-500 font-medium">No templates yet</p>
            <p className="text-sm text-zinc-400 mt-1">Click "New Template" to build a vehicle and its parts</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {templates.map((template) => (
              <div key={template.id} className="bg-white rounded-xl border border-zinc-200 overflow-hidden hover:shadow-md transition-shadow">
                <div className="h-40 bg-zinc-100 relative overflow-hidden">
                  {template.front_image_path ? (
                    <img
                      src={supabase.storage.from('vehicles').getPublicUrl(template.front_image_path).data.publicUrl}
                      alt={template.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Car size={32} className="text-zinc-300" />
                    </div>
                  )}
                  <div className="absolute top-2 right-2">
                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-brand-100 text-brand-700">
                      Template
                    </span>
                  </div>
                </div>

                <div className="p-4">
                  <h3 className="font-semibold text-zinc-900">{template.name}</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {template.part_count} {template.part_count === 1 ? 'part' : 'parts'} traced
                    {' · '}Created {formatDate(template.created_at)}
                  </p>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => navigate(`/admin/templates/${template.id}`)}
                      className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      <Edit3 size={14} />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(template)}
                      className="flex items-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-lg px-3 py-1.5 transition-colors ml-auto"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateTemplateModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(newId) => navigate(`/admin/templates/${newId}`)}
        />
      )}
    </div>
  )
}

function CreateTemplateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [year, setYear] = useState('')
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { data, error } = await supabase.from('vehicles').insert({
      shop_id: null,
      is_template: true,
      name: name.trim(),
      year: year ? parseInt(year) : null,
      make: make.trim() || null,
      model: model.trim() || null,
      status: 'draft',
    }).select('id').single()
    if (error) {
      setError(error.message)
      setSubmitting(false)
    } else {
      onCreated(data.id)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-zinc-900">New Vehicle Template</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Display Name *</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="2024 GMC Sierra 2500 HD"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Year</label>
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="2024" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Make</label>
              <input type="text" value={make} onChange={(e) => setMake(e.target.value)}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="GMC" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Model</label>
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="Sierra" />
            </div>
          </div>
          <button type="submit" disabled={submitting}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors">
            {submitting ? 'Creating…' : 'Create Template'}
          </button>
        </form>
      </div>
    </div>
  )
}
