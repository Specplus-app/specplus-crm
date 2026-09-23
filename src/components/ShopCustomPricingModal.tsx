import { useState } from 'react'
import { PartEntry, ShipSize, SHIP_SIZES, formatCurrency, supabase } from '../lib/supabase'
import { X, DollarSign, Truck, Clock, Image as ImageIcon, Save } from 'lucide-react'

function customUploadUrl(path: string | null | undefined): string | null {
  if (!path) return null
  return supabase.storage.from('customer-uploads').getPublicUrl(path).data.publicUrl
}

export default function ShopCustomPricingModal({
  item, onClose, onSave,
}: {
  item: PartEntry
  onClose: () => void
  onSave: (updated: PartEntry) => void
}) {
  const [name, setName] = useState(item.name)
  const [type, setType] = useState<'new' | 'send'>(item.type)
  const [partCost, setPartCost] = useState(item.part_cost != null ? String(item.part_cost) : '')
  const [paintPrice, setPaintPrice] = useState(item.paint_price != null ? String(item.paint_price) : '')
  const [shipSize, setShipSize] = useState<ShipSize>(item.ship_size ?? 'medium')
  const [leadTimeDays, setLeadTimeDays] = useState(item.lead_time_days != null ? String(item.lead_time_days) : '')

  const partCostNum = Math.max(0, parseFloat(partCost) || 0)
  const paintPriceNum = Math.max(0, parseFloat(paintPrice) || 0)
  const leadTimeNum = Math.max(0, Math.round(parseFloat(leadTimeDays) || 0))
  const linePrice = type === 'new' ? partCostNum + paintPriceNum : paintPriceNum
  const refUrl = customUploadUrl(item.reference_image_path)

  const handleSave = () => {
    onSave({
      ...item,
      name: name.trim() || item.name,
      type,
      part_cost: partCostNum,
      paint_price: paintPriceNum,
      ship_size: shipSize,
      lead_time_days: leadTimeNum,
      price: linePrice,
      highlight_color: type === 'new' ? 'blue' : 'green',
      priced: true,
    })
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-lg font-bold text-zinc-900">Price this part</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors"><X size={20} /></button>
        </div>

        <div className="p-5 space-y-5">
          {(item.notes || refUrl) && (
            <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Customer request</p>
              {item.notes && <p className="text-sm text-zinc-700 whitespace-pre-wrap">{item.notes}</p>}
              {refUrl && (
                <a href={refUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
                  <ImageIcon size={14} /> View reference photo
                </a>
              )}
              <p className="text-xs text-zinc-500">
                Customer asked to <span className="font-medium">{item.type === 'new' ? 'buy a new part' : 'paint their own part'}</span>.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Part name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-50 border border-zinc-200 text-zinc-900 text-sm rounded-lg px-3 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Fulfillment</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setType('new')}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${type === 'new' ? 'bg-brand-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
                Buy New
              </button>
              <button type="button" onClick={() => setType('send')}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${type === 'send' ? 'bg-brand-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
                Paint Mine
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                Part Cost {type === 'send' && <span className="text-zinc-400 normal-case font-normal">(n/a)</span>}
              </label>
              <div className="relative">
                <DollarSign size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input type="number" min="0" step="0.01" value={partCost} onChange={(e) => setPartCost(e.target.value)}
                  disabled={type === 'send'} placeholder="0.00"
                  className="w-full bg-zinc-50 border border-zinc-200 text-zinc-900 text-sm rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 disabled:bg-zinc-100 disabled:text-zinc-400" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Paint Price</label>
              <div className="relative">
                <DollarSign size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input type="number" min="0" step="0.01" value={paintPrice} onChange={(e) => setPaintPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-zinc-50 border border-zinc-200 text-zinc-900 text-sm rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Ship Size</label>
              <div className="relative">
                <Truck size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <select value={shipSize} onChange={(e) => setShipSize(e.target.value as ShipSize)}
                  className="w-full bg-zinc-50 border border-zinc-200 text-zinc-900 text-sm rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 appearance-none cursor-pointer">
                  {SHIP_SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Lead Time (days)</label>
              <div className="relative">
                <Clock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input type="number" min="0" step="1" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)}
                  placeholder="0"
                  className="w-full bg-zinc-50 border border-zinc-200 text-zinc-900 text-sm rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-zinc-100">
            <div>
              <p className="text-xs text-zinc-500">Line price</p>
              <p className="text-xl font-bold text-zinc-900">{formatCurrency(linePrice)}</p>
            </div>
            <button onClick={handleSave}
              className="bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm rounded-lg px-5 py-2.5 transition-colors flex items-center gap-2">
              <Save size={16} />
              Save Price
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
