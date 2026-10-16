// Shop logo upload/removal (moved unchanged from the Vehicles page): same
// validation, storage bucket and path, and shops.logo_url update, so storage
// policies and RLS decide access exactly as before. Changes are announced so
// every place showing the logo (e.g. the sidebar) refreshes without a reload.
import type { SupabaseClient } from '@supabase/supabase-js'

export const SHOP_LOGO_BUCKET = 'shop-logos'
export const MAX_LOGO_BYTES = 3 * 1024 * 1024
export const SHOP_LOGO_CHANGED = 'specplus:shop-logo-changed'

export type ShopLogoChange = { shopId: string; logoUrl: string | null }

export function validateLogoFile(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return 'Please choose an image file.'
  if (file.size > MAX_LOGO_BYTES) return 'Logo must be under 3 MB.'
  return null
}

export function logoStoragePath(shopId: string, fileName: string, now = Date.now()): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || 'png'
  return `shop-${shopId}/logo-${now}.${ext}`
}

export type LogoResult = { ok: true; logoUrl: string | null } | { ok: false; error: string }

export async function uploadShopLogo(client: SupabaseClient, shopId: string, file: File): Promise<LogoResult> {
  const invalid = validateLogoFile(file)
  if (invalid) return { ok: false, error: invalid }
  const path = logoStoragePath(shopId, file.name)
  const { error: uploadError } = await client.storage.from(SHOP_LOGO_BUCKET).upload(path, file, { upsert: true })
  if (uploadError) return { ok: false, error: 'Upload failed. Please try again.' }
  const publicUrl = client.storage.from(SHOP_LOGO_BUCKET).getPublicUrl(path).data.publicUrl
  const { error: updateError } = await client.from('shops').update({ logo_url: publicUrl }).eq('id', shopId)
  if (updateError) return { ok: false, error: 'Could not save your logo. Please try again.' }
  announceLogoChange({ shopId, logoUrl: publicUrl })
  return { ok: true, logoUrl: publicUrl }
}

export async function removeShopLogo(client: SupabaseClient, shopId: string): Promise<LogoResult> {
  const { error } = await client.from('shops').update({ logo_url: null }).eq('id', shopId)
  if (error) return { ok: false, error: 'Could not remove your logo. Please try again.' }
  announceLogoChange({ shopId, logoUrl: null })
  return { ok: true, logoUrl: null }
}

function announceLogoChange(change: ShopLogoChange) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ShopLogoChange>(SHOP_LOGO_CHANGED, { detail: change }))
}

export function onShopLogoChange(handler: (change: ShopLogoChange) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ShopLogoChange>).detail)
  window.addEventListener(SHOP_LOGO_CHANGED, listener)
  return () => window.removeEventListener(SHOP_LOGO_CHANGED, listener)
}
