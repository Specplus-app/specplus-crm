import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, Vehicle, Shop, VehiclePart, PartGroup, PartPaintStyle, PartOption, formatCurrency, HIGHLIGHT_COLORS, getHighlightColor, ShipSize, SHIP_SIZES, shipSizeRank, estimateLeadTimeDays, DEFAULT_LEAD_TIME_MULTIPLIER } from '../lib/supabase'
import { pickPartAtPoint } from '../lib/svgHit'
import { ArrowLeft, Upload, Plus, Trash2, Save, Eye, EyeOff, Car, X, Image as ImageIcon, GitMerge, ChevronRight, Play, Check, Layers, ZoomIn, ZoomOut, Maximize2, MousePointer2, Square, Hand, Undo2, PenTool, Palette, ChevronUp, ChevronDown, Clock } from 'lucide-react'

type Point = { x: number; y: number }
type DraftPart = {
  id: string | null
  name: string
  view: 'front' | 'rear'
  svg_path: string
  part_cost: number
  paint_price: number
  allow_send_parts: boolean
  lead_time_days: number
  sort_order: number
  group_id: string | null
  highlight_color: string
  ship_size: ShipSize
  external_url: string
}

const STORAGE_BUCKET = 'vehicles'

export default function VehicleBuilder() {
  const { vehicleId } = useParams<{ vehicleId: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const templateRoute = location.pathname.startsWith('/admin')
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [parts, setParts] = useState<VehiclePart[]>([])
  const [groups, setGroups] = useState<PartGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [activeView, setActiveView] = useState<'front' | 'rear'>('front')
  const [draftParts, setDraftParts] = useState<DraftPart[]>([])
  const [isDrawing, setIsDrawing] = useState(false)
  const [currentPoints, setCurrentPoints] = useState<Point[]>([])
  const [editingPartId, setEditingPartId] = useState<string | null>(null)
  const [showPartForm, setShowPartForm] = useState(false)
  const [partForm, setPartForm] = useState<DraftPart>(emptyPart('front'))
  const [saving, setSaving] = useState(false)
  const [uploadingView, setUploadingView] = useState<'front' | 'rear' | null>(null)
  const [mergeMode, setMergeMode] = useState(false)
  const [mergeSelection, setMergeSelection] = useState<string[]>([])
  const [showMergeModal, setShowMergeModal] = useState(false)
  const [mergePrimaryChoice, setMergePrimaryChoice] = useState<string>('')
  const [merging, setMerging] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [zoom, setZoom] = useState(1)
  const [groupCostError, setGroupCostError] = useState<string | null>(null)
  const [drawTool, setDrawTool] = useState<'polygon' | 'rectangle'>('polygon')
  const [panMode, setPanMode] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [rectStart, setRectStart] = useState<Point | null>(null)
  const [rectCurrent, setRectCurrent] = useState<Point | null>(null)
  const [editShapePartId, setEditShapePartId] = useState<string | null>(null)
  const [editPoints, setEditPoints] = useState<Point[]>([])
  const [draggedPointIdx, setDraggedPointIdx] = useState<number | null>(null)
  const [paintStyles, setPaintStyles] = useState<PartPaintStyle[]>([])
  const [partOptions, setPartOptions] = useState<PartOption[]>([])
  const imageRef = useRef<HTMLImageElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [showPushModal, setShowPushModal] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panStartRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null)
  const [svgPixelWidth, setSvgPixelWidth] = useState(0)
  const dotRadius = svgPixelWidth > 0 ? (2 / svgPixelWidth) * 100 : 0.4
  const editDotRadius = svgPixelWidth > 0 ? (3 / svgPixelWidth) * 100 : 0.6

  function emptyPart(view: 'front' | 'rear'): DraftPart {
    return {
      id: null, name: '', view, svg_path: '',
      part_cost: 0, paint_price: 0, allow_send_parts: true,
      lead_time_days: 7, sort_order: 0, group_id: null, highlight_color: 'green', ship_size: 'medium', external_url: '',
    }
  }

  const loadVehicle = useCallback(async () => {
    if (!vehicleId) return
    const [vRes, pRes, gRes] = await Promise.all([
      supabase.from('vehicles').select('*').eq('id', vehicleId).maybeSingle(),
      supabase.from('vehicle_parts').select('*').eq('vehicle_id', vehicleId).order('sort_order', { ascending: true }),
      supabase.from('part_groups').select('*').eq('vehicle_id', vehicleId).order('sort_order', { ascending: true }),
    ])
    if (vRes.data) setVehicle(vRes.data as Vehicle)
    if (pRes.data) {
      setParts(pRes.data as VehiclePart[])
      setDraftParts((pRes.data as VehiclePart[]).map((p) => ({
        id: p.id, name: p.name, view: p.view as 'front' | 'rear',
        svg_path: p.svg_path, part_cost: p.part_cost, paint_price: p.paint_price,
        allow_send_parts: p.allow_send_parts, lead_time_days: p.lead_time_days,
        sort_order: p.sort_order, group_id: p.group_id, highlight_color: p.highlight_color,
        ship_size: p.ship_size, external_url: p.external_url ?? '',
      })))
    }
    if (gRes.data) setGroups(gRes.data as PartGroup[])
    setLoading(false)
  }, [vehicleId])

  useEffect(() => {
    loadVehicle()
  }, [loadVehicle])

  useEffect(() => {
    if (!svgRef.current) return
    const updateWidth = () => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (rect) setSvgPixelWidth(rect.width)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(svgRef.current)
    return () => observer.disconnect()
  }, [activeView, zoom])

  const getImageUrl = (path: string | null): string | null => {
    if (!path) return null
    return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl
  }

  const frontUrl = getImageUrl(vehicle?.front_image_path ?? null)
  const rearUrl = getImageUrl(vehicle?.rear_image_path ?? null)
  const currentImageUrl = activeView === 'front' ? frontUrl : rearUrl
  const isTemplate = vehicle?.is_template === true
  const storageFolder = isTemplate
    ? `template-${vehicle?.id}`
    : `shop-${profile?.shop_id}/vehicle-${vehicle?.id}`

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onWheelZoom = (e: WheelEvent) => {
      e.preventDefault()
      setZoom((z) => Math.min(5, Math.max(1, z - e.deltaY * 0.0025 * z)))
    }
    container.addEventListener('wheel', onWheelZoom, { passive: false })
    return () => container.removeEventListener('wheel', onWheelZoom)
  }, [currentImageUrl])

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, view: 'front' | 'rear') => {
    const file = e.target.files?.[0]
    if (!file || !vehicle) return
    if (!isTemplate && !profile?.shop_id) return
    setUploadingView(view)

    const ext = file.name.split('.').pop() || 'jpg'
    const path = `${storageFolder}/${view}.${ext}`

    const oldPath = view === 'front' ? vehicle.front_image_path : vehicle.rear_image_path
    if (oldPath && oldPath !== path) {
      await supabase.storage.from(STORAGE_BUCKET).remove([oldPath])
    }

    const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { upsert: true })
    if (uploadError) {
      console.error('Upload failed:', uploadError.message)
      setUploadingView(null)
      return
    }

    const update = view === 'front' ? { front_image_path: path } : { rear_image_path: path }
    const { error: dbError } = await supabase.from('vehicles').update(update).eq('id', vehicle.id)
    if (dbError) {
      console.error('DB update failed:', dbError.message)
    } else {
      setVehicle({ ...vehicle, ...update })
    }
    setUploadingView(null)
  }

  const canFreePan = () => !isDrawing && !editShapePartId && !mergeMode && zoom > 1

  const getRelativeCoords = (e: React.MouseEvent): Point => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    }
  }

  const handleSvgClick = (e: React.MouseEvent) => {
    if (panMode || !isDrawing || drawTool !== 'polygon') return
    const pt = getRelativeCoords(e)
    setCurrentPoints((prev) => [...prev, pt])
  }

  const pointsToSvgPath = (pts: Point[]): string => {
    if (pts.length === 0) return ''
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z'
  }

  const svgPathToPoints = (path: string): Point[] => {
    const matches = path.match(/([ML])\s+([\d.]+)\s+([\d.]+)/g)
    if (!matches) return []
    return matches.map((m) => {
      const parts = m.split(/\s+/)
      return { x: parseFloat(parts[1]), y: parseFloat(parts[2]) }
    })
  }

  const rectToPoints = (start: Point, end: Point): Point[] => [
    { x: start.x, y: start.y },
    { x: end.x, y: start.y },
    { x: end.x, y: end.y },
    { x: start.x, y: end.y },
  ]

  const handleSvgMouseDown = (e: React.MouseEvent) => {
    if (panMode || canFreePan()) {
      if (!scrollRef.current) return
      e.preventDefault()
      panStartRef.current = {
        x: e.clientX, y: e.clientY,
        scrollLeft: scrollRef.current.scrollLeft,
        scrollTop: scrollRef.current.scrollTop,
      }
      setIsPanning(true)
      return
    }
    if (isDrawing && drawTool === 'rectangle') {
      e.preventDefault()
      const pt = getRelativeCoords(e)
      setRectStart(pt)
      setRectCurrent(pt)
    }
  }

  const handleSvgMouseMove = (e: React.MouseEvent) => {
    if (isPanning && panStartRef.current && scrollRef.current) {
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      scrollRef.current.scrollLeft = panStartRef.current.scrollLeft - dx
      scrollRef.current.scrollTop = panStartRef.current.scrollTop - dy
      return
    }
    if (isDrawing && drawTool === 'rectangle' && rectStart) {
      setRectCurrent(getRelativeCoords(e))
    } else if (draggedPointIdx !== null) {
      const pt = getRelativeCoords(e)
      setEditPoints((prev) => prev.map((p, i) => i === draggedPointIdx ? pt : p))
    }
  }

  const handleSvgMouseUp = (e: React.MouseEvent) => {
    if (isPanning) {
      panStartRef.current = null
      setIsPanning(false)
      return
    }
    if (isDrawing && drawTool === 'rectangle' && rectStart) {
      const end = getRelativeCoords(e)
      if (Math.abs(end.x - rectStart.x) > 1 && Math.abs(end.y - rectStart.y) > 1) {
        const pts = rectToPoints(rectStart, end)
        setIsDrawing(false)
        setRectStart(null)
        setRectCurrent(null)
        setPartForm({ ...emptyPart(activeView), svg_path: pointsToSvgPath(pts) })
        setPaintStyles([])
        setPartOptions([])
        setShowPartForm(true)
      } else {
        setRectStart(null)
        setRectCurrent(null)
      }
    } else if (draggedPointIdx !== null) {
      setDraggedPointIdx(null)
    }
  }

  const startEditShape = (part: VehiclePart) => {
    setEditShapePartId(part.id)
    setEditPoints(svgPathToPoints(part.svg_path))
    setIsDrawing(false)
    setMergeMode(false)
    if (part.view !== activeView) setActiveView(part.view)
  }

  const cancelEditShape = () => {
    setEditShapePartId(null)
    setEditPoints([])
    setDraggedPointIdx(null)
  }

  const saveEditedShape = async () => {
    if (!editShapePartId || editPoints.length < 3) return
    const svgPath = pointsToSvgPath(editPoints)
    const { error } = await supabase.from('vehicle_parts').update({ svg_path: svgPath }).eq('id', editShapePartId)
    if (error) {
      console.error('Failed to save shape:', error.message)
    } else {
      setParts((prev) => prev.map((p) => p.id === editShapePartId ? { ...p, svg_path: svgPath } : p))
      setDraftParts((prev) => prev.map((p) => p.id === editShapePartId ? { ...p, svg_path: svgPath } : p))
    }
    cancelEditShape()
  }

  const startDrawing = () => {
    setIsDrawing(true)
    setCurrentPoints([])
    setEditingPartId(null)
    setEditShapePartId(null)
    setRectStart(null)
    setRectCurrent(null)
    setZoom(1)
  }

  const cancelDrawing = () => {
    setIsDrawing(false)
    setCurrentPoints([])
  }

  const finishDrawing = () => {
    if (currentPoints.length < 3) {
      cancelDrawing()
      return
    }
    setIsDrawing(false)
    const svgPath = pointsToSvgPath(currentPoints)
    setPartForm({
      ...emptyPart(activeView),
      svg_path: svgPath,
    })
    setPaintStyles([])
    setPartOptions([])
    setShowPartForm(true)
  }

  const handleSavePart = async () => {
    if (!vehicleId || !partForm.name.trim()) return

    if (partForm.group_id) {
      const existingInGroup = parts.filter((p) => p.group_id === partForm.group_id && p.id !== partForm.id)
      if (existingInGroup.length > 0) {
        const expectedCost = existingInGroup[0].part_cost
        if (partForm.part_cost !== expectedCost) {
          setGroupCostError(
            `Parts cost must be ${formatCurrency(expectedCost)} to match other parts in this group. ` +
            `"${existingInGroup[0].name}" uses ${formatCurrency(expectedCost)}.`
          )
          return
        }
      }
    }
    setGroupCostError(null)
    setSaving(true)

    let savedPartId: string | null = partForm.id

    if (partForm.id) {
      const { data, error } = await supabase.from('vehicle_parts')
        .update({
          name: partForm.name,
          svg_path: partForm.svg_path,
          part_cost: partForm.part_cost,
          paint_price: partForm.paint_price,
          allow_send_parts: partForm.allow_send_parts,
          lead_time_days: partForm.lead_time_days,
          group_id: partForm.group_id,
          highlight_color: partForm.highlight_color,
          ship_size: partForm.ship_size,
          external_url: partForm.external_url.trim() || null,
        })
        .eq('id', partForm.id)
        .select('*')
        .single()
      if (!error && data) {
        setParts((prev) => prev.map((p) => p.id === data.id ? data as VehiclePart : p))
        setDraftParts((prev) => prev.map((p) => p.id === data.id ? { ...partForm, ...data } : p))
        savedPartId = data.id
      }
    } else {
      const maxOrder = Math.max(0, ...draftParts.filter((p) => p.view === activeView).map((p) => p.sort_order))
      const { data, error } = await supabase.from('vehicle_parts')
        .insert({
          vehicle_id: vehicleId,
          name: partForm.name.trim(),
          view: partForm.view,
          svg_path: partForm.svg_path,
          part_cost: partForm.part_cost,
          paint_price: partForm.paint_price,
          allow_send_parts: partForm.allow_send_parts,
          lead_time_days: partForm.lead_time_days,
          sort_order: maxOrder + 1,
          group_id: partForm.group_id,
          highlight_color: partForm.highlight_color,
          ship_size: partForm.ship_size,
          external_url: partForm.external_url.trim() || null,
        })
        .select('*')
        .single()
      if (!error && data) {
        setParts((prev) => [...prev, data as VehiclePart])
        setDraftParts((prev) => [...prev, { ...partForm, id: data.id, sort_order: maxOrder + 1 }])
        savedPartId = data.id
      }
    }

    if (savedPartId) {
      await supabase.from('part_paint_styles').delete().eq('part_id', savedPartId)
      const validStyles = paintStyles.filter((s) => s.name.trim())
      if (validStyles.length > 0) {
        await supabase.from('part_paint_styles').insert(
          validStyles.map((s, i) => ({
            part_id: savedPartId, name: s.name.trim(), image_path: s.image_path,
            price: s.price, sort_order: i,
          }))
        )
      }
      await supabase.from('part_options').delete().eq('part_id', savedPartId)
      const validOptions = partOptions.filter((o) => o.name.trim())
      if (validOptions.length > 0) {
        await supabase.from('part_options').insert(
          validOptions.map((o, i) => ({
            part_id: savedPartId, name: o.name.trim(), description: o.description,
            price: o.price, sort_order: i,
          }))
        )
      }
    }

    setShowPartForm(false)
    setCurrentPoints([])
    setPartForm(emptyPart(activeView))
    setGroupCostError(null)
    setPaintStyles([])
    setPartOptions([])
    setSaving(false)
  }

  const handleEditPart = async (part: VehiclePart) => {
    setEditingPartId(part.id)
    setPartForm({
      id: part.id, name: part.name, view: part.view as 'front' | 'rear',
      svg_path: part.svg_path, part_cost: part.part_cost,
      paint_price: part.paint_price, allow_send_parts: part.allow_send_parts,
      lead_time_days: part.lead_time_days, sort_order: part.sort_order,
      group_id: part.group_id, highlight_color: part.highlight_color,
      ship_size: part.ship_size, external_url: part.external_url ?? '',
    })
    const [stylesRes, optionsRes] = await Promise.all([
      supabase.from('part_paint_styles').select('*').eq('part_id', part.id).order('sort_order', { ascending: true }),
      supabase.from('part_options').select('*').eq('part_id', part.id).order('sort_order', { ascending: true }),
    ])
    setPaintStyles((stylesRes.data as PartPaintStyle[]) ?? [])
    setPartOptions((optionsRes.data as PartOption[]) ?? [])
    setShowPartForm(true)
    if (part.view !== activeView) setActiveView(part.view)
  }

  const handleDeletePart = async (partId: string) => {
    if (!confirm('Delete this part?')) return
    const { error } = await supabase.from('vehicle_parts').delete().eq('id', partId)
    if (error) {
      console.error('Delete failed:', error.message)
    } else {
      setParts((prev) => prev.filter((p) => p.id !== partId))
      setDraftParts((prev) => prev.filter((p) => p.id !== partId))
    }
  }

  const handleTogglePublish = async () => {
    if (!vehicle) return
    const newStatus = vehicle.status === 'published' ? 'draft' : 'published'
    const { error } = await supabase.from('vehicles').update({ status: newStatus }).eq('id', vehicle.id)
    if (error) {
      console.error('Failed to update status:', error.message)
    } else {
      setVehicle({ ...vehicle, status: newStatus })
    }
  }

  // ── Group CRUD ────────────────────────────────────────────────────────────
  const handleCreateGroup = async () => {
    if (!vehicleId || !newGroupName.trim()) return
    const maxOrder = Math.max(0, ...groups.map((g) => g.sort_order))
    const { data, error } = await supabase.from('part_groups')
      .insert({ vehicle_id: vehicleId, name: newGroupName.trim(), sort_order: maxOrder + 1 })
      .select('*')
      .single()
    if (!error && data) {
      setGroups((prev) => [...prev, data as PartGroup])
    }
    setShowGroupForm(false)
    setNewGroupName('')
  }

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm('Delete this group? Parts will remain but become standalone (no group pricing).')) return
    await supabase.from('vehicle_parts').update({ group_id: null }).eq('group_id', groupId)
    const { error } = await supabase.from('part_groups').delete().eq('id', groupId)
    if (error) {
      console.error('Delete group failed:', error.message)
    } else {
      setGroups((prev) => prev.filter((g) => g.id !== groupId))
      setParts((prev) => prev.map((p) => p.group_id === groupId ? { ...p, group_id: null } : p))
      setDraftParts((prev) => prev.map((p) => p.group_id === groupId ? { ...p, group_id: null } : p))
    }
  }

  // ── Merge logic ──────────────────────────────────────────────────────────
  const startMergeMode = () => {
    setMergeMode(true)
    setMergeSelection([])
  }

  const cancelMergeMode = () => {
    setMergeMode(false)
    setMergeSelection([])
  }

  const toggleMergeSelection = (partId: string) => {
    setMergeSelection((prev) =>
      prev.includes(partId) ? prev.filter((id) => id !== partId) : [...prev, partId]
    )
  }

  const openMergeModal = () => {
    if (mergeSelection.length < 2) return
    setMergePrimaryChoice(mergeSelection[0])
    setShowMergeModal(true)
  }

  const handleMergeParts = async () => {
    if (mergeSelection.length < 2 || !mergePrimaryChoice) return
    setMerging(true)

    const primaryPart = parts.find((p) => p.id === mergePrimaryChoice)
    if (!primaryPart) { setMerging(false); return }

    const otherParts = parts.filter((p) => mergeSelection.includes(p.id) && p.id !== mergePrimaryChoice)
    const otherIds = otherParts.map((p) => p.id)
    const combinedSvgPath = [primaryPart.svg_path, ...otherParts.map((p) => p.svg_path)].join(' ')

    const { data: updatedPrimary, error: updateError } = await supabase.from('vehicle_parts')
      .update({ svg_path: combinedSvgPath })
      .eq('id', primaryPart.id)
      .select('*')
      .single()

    if (updateError || !updatedPrimary) {
      console.error('Merge failed:', updateError?.message)
      setMerging(false)
      return
    }

    const { error: deleteError } = await supabase.from('vehicle_parts')
      .delete()
      .in('id', otherIds)

    if (deleteError) {
      console.error('Merge cleanup failed:', deleteError.message)
      setMerging(false)
      return
    }

    setParts((prev) => prev
      .filter((p) => !otherIds.includes(p.id))
      .map((p) => p.id === primaryPart.id ? updatedPrimary as VehiclePart : p))
    setDraftParts((prev) => prev
      .filter((p) => !p.id || !otherIds.includes(p.id))
      .map((p) => p.id === primaryPart.id ? { ...p, svg_path: combinedSvgPath } : p))

    setShowMergeModal(false)
    setMergeMode(false)
    setMergeSelection([])
    setMerging(false)
  }

  const handleReorderPart = async (partId: string, direction: 'up' | 'down') => {
    const list = parts
      .filter((p) => p.view === activeView && !p.group_id)
      .sort((a, b) => a.sort_order - b.sort_order)
    const idx = list.findIndex((p) => p.id === partId)
    if (idx === -1) return
    // "up" = bring to front (toward end of array, higher sort_order = drawn on top)
    const swapIdx = direction === 'up' ? idx + 1 : idx - 1
    if (swapIdx < 0 || swapIdx >= list.length) return
    const a = list[idx]
    const b = list[swapIdx]
    const aOrder = a.sort_order
    const bOrder = b.sort_order
    setParts((prev) => prev.map((p) => p.id === a.id ? { ...p, sort_order: bOrder } : p.id === b.id ? { ...p, sort_order: aOrder } : p))
    setDraftParts((prev) => prev.map((p) => p.id === a.id ? { ...p, sort_order: bOrder } : p.id === b.id ? { ...p, sort_order: aOrder } : p))
    await Promise.all([
      supabase.from('vehicle_parts').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('vehicle_parts').update({ sort_order: aOrder }).eq('id', b.id),
    ])
  }

  // ── Derived data ─────────────────────────────────────────────────────────
  const partsForView = parts.filter((p) => p.view === activeView).sort((a, b) => a.sort_order - b.sort_order)
  const ungroupedParts = partsForView.filter((p) => !p.group_id)
  const groupsForView = groups.filter((g) => partsForView.some((p) => p.group_id === g.id))

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-zinc-300 border-t-brand-500 rounded-full animate-spin" />
      </div>
    )
  }

  if (!vehicle) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 font-medium">Vehicle not found</p>
          <button onClick={() => navigate('/dashboard/vehicles')} className="text-sm text-brand-600 hover:underline mt-2">
            Back to vehicles
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => navigate(templateRoute ? '/admin/templates' : '/dashboard/vehicles')}
            className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            <ArrowLeft size={16} />
            {templateRoute ? 'Back to templates' : 'Back to vehicles'}
          </button>
          {isTemplate ? (
            <button
              onClick={() => setShowPushModal(true)}
              className="flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 transition-colors bg-brand-600 text-white hover:bg-brand-700"
            >
              <Play size={16} />
              Push to Shops
            </button>
          ) : (
            <button
              onClick={handleTogglePublish}
              className={`flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 transition-colors ${
                vehicle.status === 'published'
                  ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                  : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
              }`}
            >
              {vehicle.status === 'published' ? <EyeOff size={16} /> : <Eye size={16} />}
              {vehicle.status === 'published' ? 'Unpublish' : 'Publish'}
            </button>
          )}
        </div>

        <h1 className="text-2xl font-bold text-zinc-900 mb-1">{vehicle.name}</h1>
        <p className="text-sm text-zinc-500 mb-6">
          {parts.length} {parts.length === 1 ? 'part' : 'parts'} traced
          {isTemplate
            ? ' · Template — push to shops to let them fill in pricing'
            : ` · ${vehicle.status === 'published' ? 'Visible to customers' : 'Draft — not visible to customers'}`}
        </p>

        {/* View toggle */}
        <div className="flex items-center gap-2 mb-4">
          {(['front', 'rear'] as const).map((v) => (
            <button
              key={v}
              onClick={() => { setActiveView(v); setCurrentPoints([]); setIsDrawing(false); setMergeMode(false); setMergeSelection([]); setZoom(1); setEditShapePartId(null); setEditPoints([]); setPanMode(false); setRectStart(null); setRectCurrent(null) }}
              className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
                activeView === v
                  ? 'bg-zinc-900 text-white'
                  : 'bg-white border border-zinc-200 text-zinc-600 hover:border-zinc-300'
              }`}
            >
              {v} View
            </button>
          ))}
          <button
            onClick={() => setPanMode(!panMode)}
            className={`flex items-center gap-1.5 text-sm font-medium rounded-lg px-3 py-2 transition-colors ${
              panMode ? 'bg-brand-100 text-brand-700 border border-brand-300' : 'text-zinc-700 bg-white border border-zinc-200 hover:border-zinc-300'
            }`}
            title="Toggle pan mode to drag the image when zoomed in"
          >
            <Hand size={16} />
            Pan
          </button>
          <div className="ml-auto flex items-center gap-2">
            {mergeMode ? (
              <>
                <span className="text-sm text-zinc-500">
                  Select 2+ parts to merge ({mergeSelection.length} selected)
                </span>
                <button onClick={cancelMergeMode} className="text-sm text-zinc-600 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={openMergeModal}
                  disabled={mergeSelection.length < 2}
                  className="text-sm text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1.5"
                >
                  <GitMerge size={14} />
                  Merge ({mergeSelection.length})
                </button>
              </>
            ) : editShapePartId ? (
              <>
                <span className="text-sm text-zinc-500">Drag points to adjust the shape ({editPoints.length} pts)</span>
                <button onClick={cancelEditShape} className="text-sm text-zinc-600 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={saveEditedShape}
                  disabled={editPoints.length < 3}
                  className="text-sm text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1.5"
                >
                  <Check size={14} />
                  Save Shape
                </button>
              </>
            ) : isDrawing ? (
              <>
                <div className="flex items-center gap-1 bg-zinc-100 rounded-lg p-0.5">
                  <button
                    onClick={() => setDrawTool('polygon')}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      drawTool === 'polygon' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                    }`}
                  >
                    <MousePointer2 size={14} />
                    Polygon
                  </button>
                  <button
                    onClick={() => setDrawTool('rectangle')}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      drawTool === 'rectangle' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                    }`}
                  >
                    <Square size={14} />
                    Rectangle
                  </button>
                </div>
                {drawTool === 'polygon' ? (
                  <>
                    <span className="text-sm text-zinc-500">{currentPoints.length} pts</span>
                    <button
                      onClick={() => setCurrentPoints((prev) => prev.slice(0, -1))}
                      disabled={currentPoints.length === 0}
                      className="text-sm text-zinc-600 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1.5"
                    >
                      <Undo2 size={14} />
                      Undo
                    </button>
                    <button onClick={cancelDrawing} className="text-sm text-zinc-600 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors">
                      Cancel
                    </button>
                    <button
                      onClick={finishDrawing}
                      disabled={currentPoints.length < 3}
                      className="text-sm text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      Done Tracing
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-sm text-zinc-500">Click and drag to draw a rectangle</span>
                    <button onClick={cancelDrawing} className="text-sm text-zinc-600 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors">
                      Cancel
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                {partsForView.length >= 2 && (
                  <button
                    onClick={startMergeMode}
                    className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 bg-white border border-zinc-200 hover:border-zinc-300 rounded-lg px-3 py-2 transition-colors"
                  >
                    <GitMerge size={16} />
                    Merge Parts
                  </button>
                )}
                {partsForView.length >= 1 && (
                  <button
                    onClick={() => setShowPreview(true)}
                    disabled={!currentImageUrl}
                    className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 bg-white border border-zinc-200 hover:border-zinc-300 rounded-lg px-3 py-2 transition-colors"
                  >
                    <Play size={16} />
                    Preview
                  </button>
                )}
                <button
                  onClick={startDrawing}
                  disabled={!currentImageUrl}
                  className="flex items-center gap-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 rounded-lg px-4 py-2 transition-colors"
                >
                  <Plus size={16} />
                  Trace New Part
                </button>
              </>
            )}
          </div>
        </div>

        {/* Image canvas */}
        <div ref={containerRef} className="relative bg-zinc-100 rounded-xl border border-zinc-200 overflow-hidden mb-6" style={{ minHeight: '300px' }}>
          {currentImageUrl ? (
            <div ref={scrollRef} className="overflow-auto" style={{ maxHeight: '70vh' }}>
            <div className="relative w-full" style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${zoom * 100}%` }}>
              <img
                ref={imageRef}
                src={currentImageUrl}
                alt={`${activeView} view`}
                className="w-full h-auto block"
                draggable={false}
              />
              <svg
                ref={svgRef}
                className="absolute inset-0 w-full h-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                onClick={handleSvgClick}
                onMouseDown={handleSvgMouseDown}
                onMouseMove={handleSvgMouseMove}
                onMouseUp={handleSvgMouseUp}
                style={{ cursor: (panMode || canFreePan()) ? (isPanning ? 'grabbing' : 'grab') : (isDrawing ? 'crosshair' : 'default') }}
              >
                {partsForView.map((part) => {
                  const isMergeSelected = mergeMode && mergeSelection.includes(part.id)
                  const isEditing = editShapePartId === part.id
                  const hc = getHighlightColor(part.highlight_color)
                  return (
                    <g key={part.id}>
                      <path
                        d={part.svg_path}
                        fill={isEditing ? 'rgba(59, 130, 246, 0.2)' : isMergeSelected ? 'rgba(168, 85, 247, 0.3)' : hc.fill.replace('0.3', '0.15')}
                        stroke={isEditing ? 'rgba(59, 130, 246, 0.9)' : isMergeSelected ? 'rgba(168, 85, 247, 0.9)' : hc.stroke.replace('0.9', '0.6')}
                        strokeWidth="0.5"
                        vectorEffect="non-scaling-stroke"
                        className={mergeMode ? 'cursor-pointer hover:fill-purple-300/40' : 'hover:opacity-80'}
                        onClick={mergeMode ? () => toggleMergeSelection(part.id) : undefined}
                      />
                    </g>
                  )
                })}
                {isDrawing && drawTool === 'polygon' && currentPoints.length > 0 && (
                  <>
                    <path
                      d={pointsToSvgPath(currentPoints)}
                      fill="rgba(34, 197, 94, 0.2)"
                      stroke="rgba(34, 197, 94, 0.9)"
                      strokeWidth="0.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    {currentPoints.map((pt, i) => (
                      <circle key={i} cx={pt.x} cy={pt.y} r={dotRadius} fill="rgb(34, 197, 94)" vectorEffect="non-scaling-size" />
                    ))}
                  </>
                )}
                {isDrawing && drawTool === 'rectangle' && rectStart && rectCurrent && (
                  <path
                    d={pointsToSvgPath(rectToPoints(rectStart, rectCurrent))}
                    fill="rgba(34, 197, 94, 0.2)"
                    stroke="rgba(34, 197, 94, 0.9)"
                    strokeWidth="0.5"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {editShapePartId && editPoints.map((pt, i) => (
                  <circle
                    key={i}
                    cx={pt.x}
                    cy={pt.y}
                    r={editDotRadius}
                    fill="rgb(59, 130, 246)"
                    stroke="white"
                    strokeWidth={editDotRadius * 0.35}
                    vectorEffect="non-scaling-stroke"
                    className="cursor-move"
                    onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); setDraggedPointIdx(i) }}
                  />
                ))}
              </svg>
            </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16">
              <ImageIcon size={40} className="text-zinc-300 mb-3" />
              <p className="text-zinc-500 font-medium mb-1">No {activeView} image uploaded</p>
              <p className="text-sm text-zinc-400 mb-4">Upload a photo to start tracing parts</p>
              <label className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 cursor-pointer transition-colors">
                <Upload size={16} />
                Upload {activeView} image
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, activeView)} />
              </label>
            </div>
          )}

          {currentImageUrl && (
            <>
            <div className="absolute top-3 left-3 flex items-center gap-1 bg-white/90 backdrop-blur-sm rounded-lg shadow-sm z-10">
              <button
                onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
                disabled={zoom <= 1}
                className="p-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 rounded-l-lg transition-colors"
                title="Zoom out"
              >
                <ZoomOut size={16} />
              </button>
              <span className="text-xs font-medium text-zinc-600 px-1 select-none">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(5, z + 0.5))}
                disabled={zoom >= 5}
                className="p-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 transition-colors"
                title="Zoom in"
              >
                <ZoomIn size={16} />
              </button>
              {zoom !== 1 && (
                <button
                  onClick={() => setZoom(1)}
                  className="p-1.5 text-zinc-700 hover:bg-zinc-100 rounded-r-lg transition-colors border-l border-zinc-200"
                  title="Reset zoom"
                >
                  <Maximize2 size={14} />
                </button>
              )}
            </div>
            <label className="absolute bottom-3 right-3 flex items-center gap-1.5 bg-white/90 backdrop-blur-sm text-zinc-700 text-xs font-medium rounded-lg px-3 py-1.5 cursor-pointer hover:bg-white transition-colors shadow-sm">
              <Upload size={14} />
              Replace
              <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, activeView)} />
            </label>
            </>
          )}

          {uploadingView === activeView && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* Parts list for this view */}
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <h2 className="text-sm font-semibold text-zinc-900 mb-3">
            {activeView.charAt(0).toUpperCase() + activeView.slice(1)} Parts ({partsForView.length})
          </h2>
          {partsForView.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-4">
              No parts traced yet for this view. Click "Trace New Part" and click around the image to outline a part.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Ungrouped parts */}
              {ungroupedParts.length > 0 && (
                <div className="space-y-2">
                  {ungroupedParts.map((part) => (
                    <div key={part.id} className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                      mergeMode && mergeSelection.includes(part.id)
                        ? 'bg-purple-50 border-purple-200'
                        : 'bg-zinc-50 border-zinc-100'
                    }`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {mergeMode && (
                            <input
                              type="checkbox"
                              checked={mergeSelection.includes(part.id)}
                              onChange={() => toggleMergeSelection(part.id)}
                              className="w-4 h-4 rounded accent-purple-600"
                            />
                          )}
                          <span className={`w-3 h-3 rounded-full ${getHighlightColor(part.highlight_color).dot} flex-shrink-0`}></span>
                          <p className="text-sm font-medium text-zinc-900">{part.name}</p>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-zinc-400">
                          <span>Parts: {formatCurrency(part.part_cost)}</span>
                          <span>Paint: {formatCurrency(part.paint_price)}</span>
                          <span>Buy New: {formatCurrency(part.part_cost + part.paint_price)}</span>
                          <span>Lead: {part.lead_time_days}d</span>
                        </div>
                      </div>
                      {!mergeMode && (
                        <div className="flex items-center gap-1.5">
                          <div className="flex flex-col gap-0.5">
                            <button
                              onClick={() => handleReorderPart(part.id, 'up')}
                              disabled={ungroupedParts.indexOf(part) === ungroupedParts.length - 1}
                              className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5"
                              title="Bring to front (drawn on top)"
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              onClick={() => handleReorderPart(part.id, 'down')}
                              disabled={ungroupedParts.indexOf(part) === 0}
                              className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5"
                              title="Send to back (drawn behind)"
                            >
                              <ChevronDown size={14} />
                            </button>
                          </div>
                          <button onClick={() => startEditShape(part)}
                            className="text-xs font-medium text-zinc-600 hover:text-zinc-800 bg-white border border-zinc-200 hover:border-zinc-300 rounded-lg px-2.5 py-1.5 transition-colors flex items-center gap-1">
                            <PenTool size={12} />
                            Shape
                          </button>
                          <button onClick={() => handleEditPart(part)}
                            className="text-xs font-medium text-brand-600 hover:text-brand-700 bg-white border border-zinc-200 hover:border-brand-300 rounded-lg px-2.5 py-1.5 transition-colors">
                            Edit
                          </button>
                          <button onClick={() => handleDeletePart(part.id)}
                            className="text-xs font-medium text-red-600 hover:text-red-700 bg-white border border-zinc-200 hover:border-red-300 rounded-lg px-2.5 py-1.5 transition-colors">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Grouped parts */}
              {groupsForView.map((group) => {
                const groupParts = partsForView.filter((p) => p.group_id === group.id)
                const totalPartCost = groupParts.reduce((sum, p) => sum + p.part_cost, 0)
                const totalPaintPrice = groupParts.reduce((sum, p) => sum + p.paint_price, 0)
                const maxLead = Math.max(...groupParts.map((p) => p.lead_time_days))
                return (
                  <div key={group.id} className="border border-zinc-200 rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between bg-zinc-100 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Layers size={14} className="text-zinc-500" />
                        <span className="text-sm font-semibold text-zinc-700">{group.name}</span>
                        <span className="text-xs text-zinc-400">{groupParts.length} part{groupParts.length !== 1 ? 's' : ''}</span>
                      </div>
                      <button onClick={() => handleDeleteGroup(group.id)} className="text-xs text-red-600 hover:text-red-700 font-medium">
                        Delete group
                      </button>
                    </div>
                    <div className="p-2 space-y-1.5">
                      <div className={`flex items-center justify-between p-2.5 rounded-lg border transition-colors ${
                        mergeMode && groupParts.some((p) => mergeSelection.includes(p.id))
                          ? 'bg-purple-50 border-purple-200'
                          : 'bg-zinc-50 border-zinc-100'
                      }`}>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {mergeMode && (
                              <input
                                type="checkbox"
                                checked={groupParts.every((p) => mergeSelection.includes(p.id))}
                                onChange={(e) => {
                                  groupParts.forEach((p) => {
                                    if (e.target.checked && !mergeSelection.includes(p.id)) toggleMergeSelection(p.id)
                                    if (!e.target.checked && mergeSelection.includes(p.id)) toggleMergeSelection(p.id)
                                  })
                                }}
                                className="w-4 h-4 rounded accent-purple-600"
                              />
                            )}
                            <span className={`w-3 h-3 rounded-full ${getHighlightColor(groupParts[0].highlight_color).dot} flex-shrink-0`}></span>
                            <p className="text-sm font-medium text-zinc-900">{group.name}</p>
                            <span className="text-xs text-zinc-400">({groupParts.map((p) => p.name).join(', ')})</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-zinc-400">
                            <span>Parts: {formatCurrency(totalPartCost)}</span>
                            <span>Paint: {formatCurrency(totalPaintPrice)}</span>
                            <span>Buy New: {formatCurrency(totalPartCost + totalPaintPrice)}</span>
                            <span>Lead: {maxLead}d</span>
                          </div>
                        </div>
                        {!mergeMode && (
                          <div className="flex items-center gap-1.5">
                            {groupParts.map((part) => (
                              <button key={part.id} onClick={() => handleEditPart(part)}
                                className="text-xs font-medium text-brand-600 hover:text-brand-700 bg-white border border-zinc-200 hover:border-brand-300 rounded-lg px-2.5 py-1.5 transition-colors">
                                Edit {part.name.split(' ')[0]}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Groups management */}
        <div className="bg-white rounded-xl border border-zinc-200 p-4 mt-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                <Layers size={16} className="text-zinc-500" />
                Parts Groups
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Group parts so the first selection offers Buy New or Paint Mine, and subsequent parts in the same group only offer Paint.
              </p>
            </div>
            <button
              onClick={() => setShowGroupForm(true)}
              className="flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 bg-white border border-zinc-200 hover:border-brand-300 rounded-lg px-3 py-1.5 transition-colors"
            >
              <Plus size={14} />
              New Group
            </button>
          </div>
          {groups.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-3">
              No groups yet. Create a group, then assign parts to it from the part editor.
            </p>
          ) : (
            <div className="space-y-2">
              {groups.map((group) => {
                const groupParts = parts.filter((p) => p.group_id === group.id)
                return (
                  <div key={group.id} className="bg-zinc-50 rounded-lg border border-zinc-100 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-medium text-zinc-900">{group.name}</p>
                      <button onClick={() => handleDeleteGroup(group.id)} className="text-xs text-red-600 hover:text-red-700 font-medium">
                        Delete
                      </button>
                    </div>
                    {groupParts.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {groupParts.map((p) => (
                          <span key={p.id} className="text-xs bg-white border border-zinc-200 rounded-full px-2 py-0.5 text-zinc-600">
                            {p.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-400 mt-1">No parts assigned yet.</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Part form modal */}
      {showPartForm && (
        <PartFormModal
          part={partForm}
          onChange={setPartForm}
          onSave={handleSavePart}
          onClose={() => { setShowPartForm(false); setCurrentPoints([]); setGroupCostError(null); setPaintStyles([]); setPartOptions([]) }}
          saving={saving}
          availableGroups={groups}
          groupCostError={groupCostError}
          paintStyles={paintStyles}
          setPaintStyles={setPaintStyles}
          partOptions={partOptions}
          setPartOptions={setPartOptions}
          shopId={profile?.shop_id ?? null}
          vehicleId={vehicleId ?? null}
          isTemplate={isTemplate}
        />
      )}

      {/* Group form modal */}
      {showGroupForm && (
        <GroupFormModal
          name={newGroupName}
          onChange={setNewGroupName}
          onSave={handleCreateGroup}
          onClose={() => { setShowGroupForm(false); setNewGroupName('') }}
        />
      )}

      {/* Merge modal */}
      {showMergeModal && (
        <MergeModal
          selectedParts={mergeSelection.map((id) => parts.find((p) => p.id === id)).filter(Boolean) as VehiclePart[]}
          primaryChoice={mergePrimaryChoice}
          onPrimaryChange={setMergePrimaryChoice}
          onMerge={handleMergeParts}
          onClose={() => setShowMergeModal(false)}
          merging={merging}
        />
      )}

      {/* Preview modal */}
      {showPreview && (
        <PreviewModal
          parts={parts}
          groups={groups}
          frontUrl={frontUrl}
          rearUrl={rearUrl}
          vehicleId={vehicleId ?? null}
          shopId={profile?.shop_id ?? null}
          onClose={() => setShowPreview(false)}
        />
      )}
      {/* Push to shops modal */}
      {showPushModal && vehicleId && (
        <PushToShopsModal
          templateId={vehicleId}
          onClose={() => setShowPushModal(false)}
        />
      )}
    </div>
  )
}

function GroupFormModal({
  name, onChange, onSave, onClose
}: {
  name: string
  onChange: (v: string) => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
            <Layers size={18} className="text-brand-600" />
            New Parts Group
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Group Name *</label>
            <input
              type="text" value={name}
              onChange={(e) => onChange(e.target.value)}
              autoFocus required
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave()}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="Front Bumper Group"
            />
            <p className="text-xs text-zinc-400 mt-1.5">
              Parts in a group share pricing: the first selected offers Buy New or Paint Mine, subsequent parts only offer Paint.
            </p>
          </div>
          <button
            onClick={onSave}
            disabled={!name.trim()}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={16} />
            Create Group
          </button>
        </div>
      </div>
    </div>
  )
}

function PartFormModal({
  part, onChange, onSave, onClose, saving, availableGroups, groupCostError,
  paintStyles, setPaintStyles, partOptions, setPartOptions, shopId, vehicleId, isTemplate
}: {
  part: DraftPart
  onChange: (p: DraftPart) => void
  onSave: () => void
  onClose: () => void
  saving: boolean
  availableGroups: PartGroup[]
  groupCostError: string | null
  paintStyles: PartPaintStyle[]
  setPaintStyles: React.Dispatch<React.SetStateAction<PartPaintStyle[]>>
  partOptions: PartOption[]
  setPartOptions: React.Dispatch<React.SetStateAction<PartOption[]>>
  shopId: string | null
  vehicleId: string | null
  isTemplate: boolean
}) {
  const handleStyleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, index: number) => {
    const file = e.target.files?.[0]
    if (!file || !vehicleId) return
    if (!isTemplate && !shopId) return
    const ext = file.name.split('.').pop() || 'jpg'
    const folder = isTemplate ? `template-${vehicleId}` : `shop-${shopId}/vehicle-${vehicleId}`
    const path = `${folder}/style-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { upsert: true })
    if (!error) {
      setPaintStyles((prev) => prev.map((s, i) => i === index ? { ...s, image_path: path } : s))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-zinc-900">{part.id ? 'Edit Part' : 'New Part'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          {groupCostError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2.5">
              <span className="text-sm">{groupCostError}</span>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Part Name *</label>
            <input
              type="text" value={part.name}
              onChange={(e) => onChange({ ...part, name: e.target.value })}
              autoFocus required
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="Front Bumper"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">External Product URL (e.g., Shopify Link)</label>
            <input
              type="url" value={part.external_url}
              onChange={(e) => onChange({ ...part, external_url: e.target.value })}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="https://yourstore.com/products/front-bumper"
            />
            <p className="text-xs text-zinc-400 mt-1">
              Optional. On your website embed, clicking this part opens this link in a new tab.
            </p>
          </div>

          {/* Group selector */}
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
              Parts Group
            </label>
            <select
              value={part.group_id ?? ''}
              onChange={(e) => onChange({ ...part, group_id: e.target.value || null })}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            >
              <option value="">None — standalone part</option>
              {availableGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <p className="text-xs text-zinc-400 mt-1">
              Parts in a group share pricing: the first selected offers Buy New or Paint Mine, subsequent parts only offer Paint.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                Parts Cost ($)
              </label>
              <input
                type="number" min="0" step="0.01" value={part.part_cost || ''}
                onChange={(e) => onChange({ ...part, part_cost: parseFloat(e.target.value) || 0 })}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                Paint Price ($)
              </label>
              <input
                type="number" min="0" step="0.01" value={part.paint_price || ''}
                onChange={(e) => onChange({ ...part, paint_price: parseFloat(e.target.value) || 0 })}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="0"
              />
            </div>
          </div>

          {/* Highlight color picker */}
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Highlight Color</label>
            <div className="flex items-center gap-2">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => onChange({ ...part, highlight_color: c.value })}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                    part.highlight_color === c.value
                      ? 'border-zinc-400 bg-zinc-50 ring-1 ring-zinc-300'
                      : 'border-zinc-200 hover:border-zinc-300'
                  }`}
                >
                  <span className={`w-4 h-4 rounded-full ${c.dot}`}></span>
                  {c.label}
                  {part.highlight_color === c.value && <Check size={14} className="text-zinc-600" />}
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-400 mt-1">
              Color shown when a customer selects this part. Use different colors for overlapping parts.
            </p>
          </div>

          {/* Paint Styles */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider">Paint Styles</label>
              <button
                type="button"
                onClick={() => setPaintStyles((prev) => [...prev, { id: '', part_id: '', name: '', image_path: null, price: 0, sort_order: prev.length, created_at: '' }])}
                className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1"
              >
                <Plus size={12} /> Add Style
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-2">
              Offer different paint options with reference photos. If none are added, the default paint price is used.
            </p>
            {paintStyles.map((style, idx) => (
              <div key={idx} className="flex items-start gap-2 bg-zinc-50 border border-zinc-200 rounded-lg p-2 mb-2">
                <div className="flex-1 space-y-2">
                  <input
                    type="text" value={style.name}
                    onChange={(e) => setPaintStyles((prev) => prev.map((s, i) => i === idx ? { ...s, name: e.target.value } : s))}
                    className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-500"
                    placeholder="Style name (e.g. Gloss Black)"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min="0" step="0.01" value={style.price || ''}
                      onChange={(e) => setPaintStyles((prev) => prev.map((s, i) => i === idx ? { ...s, price: parseFloat(e.target.value) || 0 } : s))}
                      className="w-24 bg-white border border-zinc-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-500"
                      placeholder="Price"
                    />
                    <label className="flex items-center gap-1 cursor-pointer text-xs text-zinc-600 hover:text-zinc-800">
                      <ImageIcon size={14} />
                      {style.image_path ? 'Change' : 'Upload'}
                      <input
                        type="file" accept="image/*" className="hidden"
                        onChange={(e) => handleStyleImageUpload(e, idx)}
                      />
                    </label>
                    {style.image_path && (
                      <img
                        src={supabase.storage.from(STORAGE_BUCKET).getPublicUrl(style.image_path).data.publicUrl}
                        alt={style.name}
                        className="w-10 h-10 rounded object-cover border border-zinc-200"
                      />
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPaintStyles((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-zinc-400 hover:text-red-500 transition-colors mt-1"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          {/* Add-On Options */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider">Add-On Options</label>
              <button
                type="button"
                onClick={() => setPartOptions((prev) => [...prev, { id: '', part_id: '', name: '', description: null, price: 0, sort_order: prev.length, created_at: '' }])}
                className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1"
              >
                <Plus size={12} /> Add Option
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-2">
              Optional add-ons (e.g. LED Conversion, Demon Eyes, Halos) customers can select.
            </p>
            {partOptions.map((option, idx) => (
              <div key={idx} className="flex items-start gap-2 bg-zinc-50 border border-zinc-200 rounded-lg p-2 mb-2">
                <div className="flex-1 space-y-2">
                  <input
                    type="text" value={option.name}
                    onChange={(e) => setPartOptions((prev) => prev.map((o, i) => i === idx ? { ...o, name: e.target.value } : o))}
                    className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-500"
                    placeholder="Option name (e.g. Amber to White LED)"
                  />
                  <input
                    type="text" value={option.description ?? ''}
                    onChange={(e) => setPartOptions((prev) => prev.map((o, i) => i === idx ? { ...o, description: e.target.value } : o))}
                    className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-500"
                    placeholder="Description (optional)"
                  />
                  <input
                    type="number" min="0" step="0.01" value={option.price || ''}
                    onChange={(e) => setPartOptions((prev) => prev.map((o, i) => i === idx ? { ...o, price: parseFloat(e.target.value) || 0 } : o))}
                    className="w-24 bg-white border border-zinc-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brand-500"
                    placeholder="Price"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setPartOptions((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-zinc-400 hover:text-red-500 transition-colors mt-1"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Lead Time (days)</label>
              <input
                type="number" min="1" value={part.lead_time_days}
                onChange={(e) => onChange({ ...part, lead_time_days: parseInt(e.target.value) || 7 })}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Shipping Size</label>
              <select
                value={part.ship_size}
                onChange={(e) => onChange({ ...part, ship_size: e.target.value as ShipSize })}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 appearance-none cursor-pointer"
              >
                {SHIP_SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Allow Send Parts?</label>
            <button
              onClick={() => onChange({ ...part, allow_send_parts: !part.allow_send_parts })}
              className={`w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                part.allow_send_parts
                  ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                  : 'bg-zinc-100 text-zinc-500 border border-zinc-200'
              }`}
            >
              {part.allow_send_parts ? 'Yes — customer can send parts' : 'No — buy new only'}
            </button>
          </div>
          <button
            onClick={onSave}
            disabled={saving || !part.name.trim()}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors flex items-center justify-center gap-2"
          >
            <Save size={16} />
            {saving ? 'Saving…' : 'Save Part'}
          </button>
        </div>
      </div>
    </div>
  )
}

type PreviewPart = {
  id: string
  name: string
  type: 'new' | 'send'
  price: number
  group_id: string | null
  group_name: string | null
  paint_style_id?: string | null
  paint_style_name?: string | null
  selected_options?: { id: string; name: string; price: number }[]
  ship_size?: ShipSize
  lead_time_days?: number
}

function PreviewModal({
  parts, groups, frontUrl, rearUrl, vehicleId, shopId, onClose
}: {
  parts: VehiclePart[]
  groups: PartGroup[]
  frontUrl: string | null
  rearUrl: string | null
  vehicleId: string | null
  shopId: string | null
  onClose: () => void
}) {
  const [activeView, setActiveView] = useState<'front' | 'rear'>('front')
  const [selectedParts, setSelectedParts] = useState<Map<string, PreviewPart>>(new Map())
  const [paintStyles, setPaintStyles] = useState<PartPaintStyle[]>([])
  const [partOptions, setPartOptions] = useState<PartOption[]>([])
  const [detailPart, setDetailPart] = useState<VehiclePart | null>(null)
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null)
  const previewSvgRef = useRef<SVGSVGElement>(null)
  const [fulfillmentMode, setFulfillmentMode] = useState<'local' | 'mail'>('local')
  const [shippingRates, setShippingRates] = useState<Record<ShipSize, number>>({ small: 0, medium: 0, large: 0, 'x-large': 0 })
  const [leadMultiplier, setLeadMultiplier] = useState<number>(DEFAULT_LEAD_TIME_MULTIPLIER)

  useEffect(() => {
    if (!vehicleId) return
    Promise.all([
      supabase.from('part_paint_styles').select('*, vehicle_parts!inner(vehicle_id)').eq('vehicle_parts.vehicle_id', vehicleId).order('sort_order', { ascending: true }),
      supabase.from('part_options').select('*, vehicle_parts!inner(vehicle_id)').eq('vehicle_parts.vehicle_id', vehicleId).order('sort_order', { ascending: true }),
    ]).then(([stylesRes, optionsRes]) => {
      setPaintStyles((stylesRes.data as PartPaintStyle[]) ?? [])
      setPartOptions((optionsRes.data as PartOption[]) ?? [])
    })
  }, [vehicleId])

  useEffect(() => {
    if (!shopId) return
    supabase.from('shops').select('customizer_config').eq('id', shopId).maybeSingle().then((res) => {
      if (res.data?.customizer_config) {
        const cfg = res.data.customizer_config as Record<string, unknown>
        const rates = cfg.shipping_rates as Record<ShipSize, number> | undefined
        if (rates) setShippingRates(rates)
        const mult = cfg.lead_time_multiplier as number | undefined
        if (typeof mult === 'number') setLeadMultiplier(mult)
      }
    })
  }, [shopId])

  const partsForView = parts.filter((p) => p.view === activeView).sort((a, b) => a.sort_order - b.sort_order)
  const currentImageUrl = activeView === 'front' ? frontUrl : rearUrl

  const groupName = (groupId: string | null) => groupId ? groups.find((g) => g.id === groupId)?.name ?? null : null

  const handlePartClick = (part: VehiclePart) => {
    if (selectedParts.has(part.id)) {
      setSelectedParts((prev) => { const next = new Map(prev); next.delete(part.id); return next })
      return
    }
    setDetailPart(part)
  }

  const addPartToSelection = (part: VehiclePart, styleId: string | null, optionIds: string[], typeOverride?: 'new' | 'send') => {
    setSelectedParts((prev) => {
      const next = new Map(prev)
      const gName = groupName(part.group_id)
      const partStyles = paintStyles.filter((s) => s.part_id === part.id)
      const selectedOptions = optionIds.map((oid) => {
        const opt = partOptions.find((o) => o.id === oid)
        return { id: oid, name: opt?.name ?? '', price: opt?.price ?? 0 }
      })
      const optionsTotal = selectedOptions.reduce((sum, o) => sum + o.price, 0)
      const groupBoughtNew = part.group_id
        ? Array.from(prev.values()).some((p) => p.group_id === part.group_id && p.type === 'new')
        : false
      const type = groupBoughtNew ? 'send' : (typeOverride ?? (part.allow_send_parts && part.paint_price > 0 ? 'send' : 'new'))
      const style = styleId ? partStyles.find((s) => s.id === styleId) : null
      const paintPrice = style ? style.price : part.paint_price
      const basePrice = type === 'new' ? part.part_cost + paintPrice : paintPrice
      next.set(part.id, {
        id: part.id, name: part.name, type, price: basePrice + optionsTotal,
        group_id: part.group_id, group_name: gName,
        paint_style_id: styleId,
        paint_style_name: styleId ? partStyles.find((s) => s.id === styleId)?.name ?? null : null,
        selected_options: selectedOptions,
        ship_size: part.ship_size,
        lead_time_days: part.lead_time_days,
      })
      return next
    })
    setDetailPart(null)
  }

  const handleSwapType = (partId: string) => {
    setSelectedParts((prev) => {
      const next = new Map(prev)
      const existing = next.get(partId)
      if (!existing) return prev
      const part = parts.find((p) => p.id === partId)
      if (!part || !part.allow_send_parts) return prev
      const newType = existing.type === 'new' ? 'send' : 'new'
      if (newType === 'new' && existing.group_id && Array.from(prev.values())
        .some((p) => p.id !== partId && p.group_id === existing.group_id && p.type === 'new')) return prev
      const partStyles = paintStyles.filter((s) => s.part_id === partId)
      const style = existing.paint_style_id ? partStyles.find((s) => s.id === existing.paint_style_id) : null
      const paintPrice = style ? style.price : part.paint_price
      const newPrice = newType === 'new' ? part.part_cost + paintPrice : paintPrice
      const optionsTotal = (existing.selected_options ?? []).reduce((sum, o) => sum + o.price, 0)
      next.set(partId, { ...existing, type: newType, price: newPrice + optionsTotal })
      return next
    })
  }

  const selectedList = Array.from(selectedParts.values())
  const partsTotal = selectedList.reduce((sum, p) => sum + p.price, 0)

  const shippingTotal = useMemo(() => {
    if (fulfillmentMode !== 'mail') return 0
    const groupIds = new Set(selectedList.filter((p) => p.group_id).map((p) => p.group_id))
    let total = 0
    for (const gid of groupIds) {
      const groupParts = selectedList.filter((p) => p.group_id === gid)
      const largest = groupParts.reduce((max, p) => shipSizeRank(p.ship_size ?? 'medium') > shipSizeRank(max.ship_size ?? 'medium') ? p : max, groupParts[0])
      total += shippingRates[largest.ship_size ?? 'medium'] ?? 0
    }
    for (const p of selectedList.filter((p) => !p.group_id)) {
      total += shippingRates[p.ship_size ?? 'medium'] ?? 0
    }
    return total
  }, [selectedList, fulfillmentMode, shippingRates])

  const grandTotal = partsTotal + shippingTotal
  const leadTimeDays = estimateLeadTimeDays(selectedList.map((p) => p.lead_time_days ?? 0), leadMultiplier)

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Play size={18} className="text-brand-500" />
              Customer Preview
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">This is exactly what your customers will see</p>
          </div>
          <button
            onClick={onClose}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 transition-colors"
          >
            <X size={16} />
            Exit Preview
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          {(['front', 'rear'] as const).map((v) => {
            const hasImage = v === 'front' ? !!frontUrl : !!rearUrl
            if (!hasImage) return null
            return (
              <button
                key={v}
                onClick={() => setActiveView(v)}
                className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
                  activeView === v ? 'bg-white text-zinc-900' : 'bg-zinc-900 border border-zinc-800 text-zinc-400'
                }`}
              >
                {v} View
              </button>
            )
          })}
        </div>

        {currentImageUrl ? (
          <div className="relative bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden mb-6">
            <img src={currentImageUrl} alt={`${activeView} view`} className="w-full h-auto block" draggable={false} />
            <svg
              ref={previewSvgRef}
              className="absolute inset-0 w-full h-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              onClick={(e) => {
                const id = previewSvgRef.current && pickPartAtPoint(previewSvgRef.current, e.clientX, e.clientY)
                const part = id ? partsForView.find((p) => p.id === id) : null
                if (part) handlePartClick(part)
              }}
              onMouseMove={(e) => {
                const id = previewSvgRef.current ? pickPartAtPoint(previewSvgRef.current, e.clientX, e.clientY) : null
                setHoveredPartId(id)
              }}
              onMouseLeave={() => setHoveredPartId(null)}
            >
              {partsForView.map((part) => {
                const selected = selectedParts.get(part.id)
                const hovered = hoveredPartId === part.id
                const color = getHighlightColor(part.highlight_color)
                return (
                  <path
                    key={part.id}
                    data-part-id={part.id}
                    d={part.svg_path}
                    fill={selected ? color.fill : hovered ? 'rgba(59, 130, 246, 0.2)' : 'transparent'}
                    stroke={selected ? color.stroke : hovered ? 'rgb(96, 165, 250)' : 'transparent'}
                    strokeWidth="0.4"
                    vectorEffect="non-scaling-stroke"
                    className="cursor-pointer transition-colors"
                  />
                )
              })}
            </svg>
          </div>
        ) : (
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-12 text-center mb-6">
            <Car size={32} className="mx-auto text-zinc-700 mb-2" />
            <p className="text-sm text-zinc-500">No {activeView} image available</p>
          </div>
        )}

        <div className="flex items-center gap-4 mb-4 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-500/30 border border-blue-500/60"></span>Available</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/30 border border-emerald-500/90"></span>Selected</span>
        </div>

        {selectedList.length > 0 && (
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 mb-4">
            <h3 className="text-sm font-semibold text-white mb-3">Your Build ({selectedList.length})</h3>
            <div className="space-y-3">
              {/* Grouped selected parts */}
              {Array.from(new Set(selectedList.filter((p) => p.group_id).map((p) => p.group_id))).map((gid) => {
                const groupParts = selectedList.filter((p) => p.group_id === gid)
                const gName = groupParts[0]?.group_name ?? 'Group'
                return (
                  <div key={gid} className="border border-zinc-800 rounded-lg overflow-hidden">
                    <div className="bg-zinc-800/50 px-3 py-1.5 flex items-center gap-2">
                      <Layers size={12} className="text-zinc-400" />
                      <span className="text-xs font-semibold text-zinc-300">{gName}</span>
                    </div>
                    <div className="p-2 space-y-1.5">
                      {groupParts.map((part, idx) => {
                        const fullPart = parts.find((p) => p.id === part.id)
                        const first = idx === 0
                        return (
                          <div key={part.id} className="flex items-center justify-between bg-zinc-800/30 rounded-lg p-2.5">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span className="text-sm font-medium text-white truncate">{part.name}</span>
                              {first && fullPart?.allow_send_parts ? (
                                <button
                                  onClick={() => handleSwapType(part.id)}
                                  className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                                    part.type === 'new' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                                  }`}
                                >
                                  {part.type === 'new' ? 'Buy New' : 'Paint Mine'}
                                </button>
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                                  Paint only
                                </span>
                              )}
                              {!first && (
                                <span className="text-xs text-zinc-500 italic">already purchased</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-sm font-medium text-white">{formatCurrency(part.price)}</span>
                              <button onClick={() => handlePartClick(fullPart!)} className="text-zinc-500 hover:text-red-400 transition-colors">
                                <span className="text-xs">Remove</span>
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {/* Ungrouped selected parts */}
              {selectedList.filter((p) => !p.group_id).map((part) => {
                const fullPart = parts.find((p) => p.id === part.id)
                return (
                  <div key={part.id} className="flex items-center justify-between bg-zinc-800/50 rounded-lg p-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="text-sm font-medium text-white truncate">{part.name}</span>
                      {fullPart?.allow_send_parts && (
                        <button
                          onClick={() => handleSwapType(part.id)}
                          className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                            part.type === 'new' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {part.type === 'new' ? 'Buy New' : 'Paint Mine'}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-sm font-medium text-white">{formatCurrency(part.price)}</span>
                      <button onClick={() => handlePartClick(fullPart!)} className="text-zinc-500 hover:text-red-400 transition-colors">
                        <span className="text-xs">Remove</span>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-2 pt-3 mt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setFulfillmentMode('local')}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  fulfillmentMode === 'local' ? 'bg-brand-600 text-white' : 'bg-zinc-950 border border-zinc-800 text-zinc-400'
                }`}
              >Local Drop-off</button>
              <button
                type="button"
                onClick={() => setFulfillmentMode('mail')}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  fulfillmentMode === 'mail' ? 'bg-brand-600 text-white' : 'bg-zinc-950 border border-zinc-800 text-zinc-400'
                }`}
              >Mail-Order DIY</button>
            </div>
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-zinc-400">Parts Total</span>
              <span className="text-sm font-medium text-white">{formatCurrency(partsTotal)}</span>
            </div>
            {fulfillmentMode === 'mail' && shippingTotal > 0 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-sm text-zinc-400">Est. Shipping</span>
                <span className="text-sm font-medium text-white">{formatCurrency(shippingTotal)}</span>
              </div>
            )}
            <div className="flex items-center justify-between pt-2 mt-2 border-t border-zinc-800">
              <span className="text-sm text-zinc-400">Total</span>
              <span className="text-lg font-bold text-white">{formatCurrency(grandTotal)}</span>
            </div>
            {leadTimeDays > 0 && (
              <div className="flex items-center gap-2 mt-3 rounded-lg bg-zinc-800/50 border border-zinc-800 px-3 py-2">
                <Clock size={15} className="text-brand-400 flex-shrink-0" />
                <span className="text-xs text-zinc-300">
                  Estimated lead time: <span className="font-semibold text-white">{leadTimeDays} {leadTimeDays === 1 ? 'day' : 'days'}</span>
                </span>
              </div>
            )}
          </div>
        )}

        {partsForView.length > 0 && selectedList.length === 0 && (
          <p className="text-sm text-zinc-500 text-center">
            {partsForView.length} parts available — click the highlighted areas on the image to add them.
          </p>
        )}

        {detailPart && (() => {
          const groupBoughtNew = !!detailPart.group_id && Array.from(selectedParts.values())
            .some((p) => p.group_id === detailPart.group_id && p.type === 'new')
          return (
            <PreviewPartDetailModal
              parts={[detailPart]}
              allPaintStyles={paintStyles}
              allPartOptions={partOptions}
              allowTypeChoice={detailPart.allow_send_parts && detailPart.paint_price > 0 && !groupBoughtNew}
              paintOnlyReason={groupBoughtNew ? 'You already chose to buy a new part in this set, so this part only needs the paint fee.' : null}
              onConfirm={(selections) => {
                selections.forEach((sel) => {
                  addPartToSelection(detailPart, sel.styleId, sel.optionIds, sel.type)
                })
              }}
              onClose={() => setDetailPart(null)}
            />
          )
        })()}
      </div>
    </div>
  )
}

type PreviewPartSelection = {
  partId: string
  styleId: string | null
  optionIds: string[]
  type: 'new' | 'send'
}

type PreviewPartConfig = {
  styleId: string | null
  optionIds: Set<string>
  type: 'new' | 'send'
}

function PreviewPartDetailModal({
  parts, allPaintStyles, allPartOptions, allowTypeChoice, paintOnlyReason, onConfirm, onClose
}: {
  parts: VehiclePart[]
  allPaintStyles: PartPaintStyle[]
  allPartOptions: PartOption[]
  allowTypeChoice: boolean
  paintOnlyReason?: string | null
  onConfirm: (selections: PreviewPartSelection[]) => void
  onClose: () => void
}) {
  const [configs, setConfigs] = useState<Record<string, PreviewPartConfig>>(() => {
    const initial: Record<string, PreviewPartConfig> = {}
    parts.forEach((part) => {
      const partStyles = allPaintStyles.filter((s) => s.part_id === part.id)
      initial[part.id] = {
        styleId: partStyles.length > 0 ? partStyles[0].id : null,
        optionIds: new Set(),
        type: paintOnlyReason
          ? 'send'
          : allowTypeChoice
            ? (part.allow_send_parts && part.paint_price > 0 ? 'send' : 'new')
            : 'new',
      }
    })
    return initial
  })

  const partTotals = parts.map((part) => {
    const cfg = configs[part.id]
    const partStyles = allPaintStyles.filter((s) => s.part_id === part.id)
    const stylePrice = cfg?.styleId ? partStyles.find((s) => s.id === cfg.styleId)?.price ?? part.paint_price : part.paint_price
    const partOpts = allPartOptions.filter((o) => o.part_id === part.id)
    const optionsTotal = Array.from(cfg?.optionIds ?? []).reduce((sum, oid) => {
      const opt = partOpts.find((o) => o.id === oid)
      return sum + (opt?.price ?? 0)
    }, 0)
    const paintTotal = cfg?.type === 'new' ? part.part_cost + stylePrice : stylePrice
    return { part, total: paintTotal + optionsTotal }
  })

  const grandPartTotal = partTotals.reduce((sum, pt) => sum + pt.total, 0)

  const updateConfig = (partId: string, patch: Partial<PreviewPartConfig>) => {
    setConfigs((prev) => ({ ...prev, [partId]: { ...prev[partId], ...patch } }))
  }

  const toggleOption = (partId: string, optionId: string) => {
    setConfigs((prev) => {
      const cfg = prev[partId]
      const next = new Set(cfg.optionIds)
      if (next.has(optionId)) next.delete(optionId)
      else next.add(optionId)
      return { ...prev, [partId]: { ...cfg, optionIds: next } }
    })
  }

  const handleConfirm = () => {
    const selections: PreviewPartSelection[] = parts.map((part) => {
      const cfg = configs[part.id]
      return {
        partId: part.id,
        styleId: cfg.styleId,
        optionIds: Array.from(cfg.optionIds),
        type: cfg.type,
      }
    })
    onConfirm(selections)
  }

  const getStyleImageUrl = (path: string | null): string | null => {
    if (!path) return null
    return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Palette size={18} className="text-brand-500" />
            {parts.length > 1 ? `${parts.length} parts selected` : parts[0].name}
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-5">
          {parts.map((part, partIdx) => {
            const cfg = configs[part.id]
            const partStyles = allPaintStyles.filter((s) => s.part_id === part.id)
            const partOpts = allPartOptions.filter((o) => o.part_id === part.id)
            const stylePrice = cfg?.styleId ? partStyles.find((s) => s.id === cfg.styleId)?.price ?? part.paint_price : part.paint_price
            const isFirst = partIdx === 0
            return (
              <div key={part.id} className={parts.length > 1 ? 'border border-zinc-800 rounded-xl p-4 space-y-4' : 'space-y-4'}>
                {parts.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">{part.name}</span>
                    {!isFirst && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-900/40 text-amber-400">
                        Paint only
                      </span>
                    )}
                  </div>
                )}

                {partStyles.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Choose Paint Style</label>
                    <div className="grid grid-cols-2 gap-3">
                      {partStyles.map((style) => (
                        <button
                          key={style.id}
                          onClick={() => updateConfig(part.id, { styleId: style.id })}
                          className={`text-left rounded-xl border overflow-hidden transition-all ${
                            cfg?.styleId === style.id
                              ? 'border-brand-500 ring-1 ring-brand-500'
                              : 'border-zinc-700 hover:border-zinc-600'
                          }`}
                        >
                          {style.image_path ? (
                            <img src={getStyleImageUrl(style.image_path)!} alt={style.name} className="w-full h-24 object-cover" />
                          ) : (
                            <div className="w-full h-24 bg-zinc-800 flex items-center justify-center">
                              <Palette size={20} className="text-zinc-600" />
                            </div>
                          )}
                          <div className="p-2">
                            <p className="text-sm font-medium text-white truncate">{style.name}</p>
                            <p className="text-xs text-zinc-400">{formatCurrency(style.price)}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {isFirst && !allowTypeChoice && paintOnlyReason && (
                  <div className="rounded-lg border border-amber-900/40 bg-amber-900/20 p-3">
                    <p className="text-xs font-semibold text-amber-400 mb-1">Paint fee only</p>
                    <p className="text-xs text-amber-200/80">{paintOnlyReason}</p>
                  </div>
                )}

                {isFirst && allowTypeChoice && (
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Buy New or Paint Mine?</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => updateConfig(part.id, { type: 'new' })}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                          cfg?.type === 'new' ? 'bg-brand-600 text-white' : 'bg-zinc-950 border border-zinc-800 text-zinc-400'
                        }`}
                      >
                        Buy New
                        <span className="block text-xs font-normal opacity-80 mt-0.5">{formatCurrency(part.part_cost + stylePrice)}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateConfig(part.id, { type: 'send' })}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                          cfg?.type === 'send' ? 'bg-brand-600 text-white' : 'bg-zinc-950 border border-zinc-800 text-zinc-400'
                        }`}
                      >
                        Paint Mine
                        <span className="block text-xs font-normal opacity-80 mt-0.5">{formatCurrency(stylePrice)}</span>
                      </button>
                    </div>
                  </div>
                )}

                {partOpts.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Add-On Options</label>
                    <div className="space-y-2">
                      {partOpts.map((option) => {
                        const checked = cfg?.optionIds.has(option.id) ?? false
                        return (
                          <button
                            key={option.id}
                            onClick={() => toggleOption(part.id, option.id)}
                            className={`w-full flex items-start gap-3 rounded-lg border p-3 transition-all text-left ${
                              checked
                                ? 'border-brand-500 bg-brand-600/10'
                                : 'border-zinc-700 hover:border-zinc-600'
                            }`}
                          >
                            <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 mt-0.5 ${
                              checked ? 'bg-brand-600 border-brand-600' : 'border-zinc-600'
                            }`}>
                              {checked && <Check size={12} className="text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-white">{option.name}</p>
                                <p className="text-sm text-zinc-400">+{formatCurrency(option.price)}</p>
                              </div>
                              {option.description && (
                                <p className="text-xs text-zinc-500 mt-0.5">{option.description}</p>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          <div className="flex items-center justify-between pt-3 border-t border-zinc-800">
            <div>
              <p className="text-xs text-zinc-500">Total for {parts.length > 1 ? `${parts.length} parts` : 'this part'}</p>
              <p className="text-xl font-bold text-white">{formatCurrency(grandPartTotal)}</p>
            </div>
            <button
              onClick={handleConfirm}
              className="bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm rounded-lg px-5 py-2.5 transition-colors flex items-center gap-2"
            >
              <Plus size={16} />
              Add to Build
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MergeModal({
  selectedParts, primaryChoice, onPrimaryChange, onMerge, onClose, merging
}: {
  selectedParts: VehiclePart[]
  primaryChoice: string
  onPrimaryChange: (id: string) => void
  onMerge: () => void
  onClose: () => void
  merging: boolean
}) {
  const primaryPart = selectedParts.find((p) => p.id === primaryChoice)
  const otherParts = selectedParts.filter((p) => p.id !== primaryChoice)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
            <GitMerge size={18} className="text-brand-600" />
            Merge Parts
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">
            Choose which part's outline will be the combined shape. All selected outlines will be merged into this part's SVG path.
          </p>

          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Primary Part (combined outline)</label>
            <select
              value={primaryChoice}
              onChange={(e) => onPrimaryChange(e.target.value)}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            >
              {selectedParts.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {formatCurrency(p.part_cost + p.paint_price)} buy new</option>
              ))}
            </select>
          </div>

          {primaryPart && otherParts.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Outlines merged into primary:</p>
              <div className="space-y-1">
                {otherParts.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 text-sm text-amber-800">
                    <ChevronRight size={12} />
                    {p.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={onMerge}
            disabled={merging || !primaryChoice}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors flex items-center justify-center gap-2"
          >
            <GitMerge size={16} />
            {merging ? 'Merging…' : 'Merge Parts'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PushToShopsModal({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const [shops, setShops] = useState<Pick<Shop, 'id' | 'name'>[]>([])
  const [existingShopIds, setExistingShopIds] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null)

  useEffect(() => {
    Promise.all([
      supabase.from('shops').select('id, name').order('name', { ascending: true }),
      supabase.from('vehicles').select('shop_id').eq('template_source_id', templateId),
    ]).then(([shopRes, existRes]) => {
      if (shopRes.data) setShops(shopRes.data as Pick<Shop, 'id' | 'name'>[])
      if (existRes.data) {
        setExistingShopIds(new Set((existRes.data as { shop_id: string | null }[]).map((r) => r.shop_id).filter(Boolean) as string[]))
      }
      setLoading(false)
    })
  }, [templateId])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handlePush = async () => {
    if (selected.size === 0) return
    setPushing(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('clone_vehicle_template', {
      p_template_id: templateId,
      p_shop_ids: Array.from(selected),
    })
    setPushing(false)
    if (rpcError) {
      setError('Could not send this template to the selected shops. Please try again.')
      return
    }
    const res = data as { created?: unknown[]; skipped?: unknown[] } | null
    const created = Array.isArray(res?.created) ? res!.created.length : 0
    const skipped = Array.isArray(res?.skipped) ? res!.skipped.length : 0
    setResult({ created, skipped })
    setExistingShopIds((prev) => new Set([...prev, ...Array.from(selected)]))
    setSelected(new Set())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
            <Play size={18} className="text-brand-600" />
            Push Template to Shops
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-zinc-500 mb-4">
          Each selected shop gets its own copy of this vehicle with all parts, groups and styles ready. Prices and lead times are left blank for the shop to fill in.
        </p>

        {result && (
          <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2.5">
            Sent to {result.created} {result.created === 1 ? 'shop' : 'shops'}.
            {result.skipped > 0 && ` ${result.skipped} already had a copy and were skipped.`}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2.5">{error}</div>
        )}

        {loading ? (
          <div className="py-8 text-center text-sm text-zinc-400">Loading shops…</div>
        ) : shops.length === 0 ? (
          <div className="py-8 text-center text-sm text-zinc-400">No shops available yet.</div>
        ) : (
          <div className="space-y-1.5 mb-5">
            {shops.map((shop) => {
              const already = existingShopIds.has(shop.id)
              return (
                <label
                  key={shop.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    already
                      ? 'border-zinc-100 bg-zinc-50 text-zinc-400 cursor-not-allowed'
                      : 'border-zinc-200 hover:border-brand-300 cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={already}
                    checked={selected.has(shop.id)}
                    onChange={() => toggle(shop.id)}
                    className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="font-medium text-zinc-800">{shop.name}</span>
                  {already && <span className="ml-auto text-xs text-zinc-400">Already has a copy</span>}
                </label>
              )
            })}
          </div>
        )}

        <button
          onClick={handlePush}
          disabled={pushing || selected.size === 0}
          className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors flex items-center justify-center gap-2"
        >
          <Play size={16} />
          {pushing ? 'Sending…' : `Send to ${selected.size} ${selected.size === 1 ? 'Shop' : 'Shops'}`}
        </button>
      </div>
    </div>
  )
}
