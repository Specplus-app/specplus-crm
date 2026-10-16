// Editable shop details (name, contact email, phone): validation and change
// detection (pure; unit tested), plus a change event so other places showing
// the shop name (e.g. the sidebar) refresh without a reload.

export type ShopDetailsDraft = { name: string; contact_email: string; phone: string }
export type ShopDetailsUpdate = Partial<{ name: string; contact_email: string; phone: string | null }>
export type ShopDetailsErrors = Partial<Record<keyof ShopDetailsDraft, string>>

export const NAME_MAX = 120
export const EMAIL_MAX = 254
export const PHONE_MAX = 40

// Same shape the notification dispatcher accepts for the shop's address, so a
// saved email can always receive new-request and customer-message emails.
const EMAIL_RE = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/
const PHONE_CHARS_RE = /^[0-9+().\-\s/]+(\s*(x|ext\.?)\s*\d{1,6})?$/i

export function draftFrom(shop: { name: string; contact_email: string | null; phone: string | null }): ShopDetailsDraft {
  return { name: shop.name ?? '', contact_email: shop.contact_email ?? '', phone: shop.phone ?? '' }
}

export function validateShopDetails(draft: ShopDetailsDraft): ShopDetailsErrors {
  const errors: ShopDetailsErrors = {}
  const name = draft.name.trim()
  const email = draft.contact_email.trim()
  const phone = draft.phone.trim()

  if (!name) errors.name = 'Enter your shop name.'
  else if (name.length > NAME_MAX) errors.name = `Keep the shop name under ${NAME_MAX} characters.`

  if (!email) errors.contact_email = 'Enter a contact email.'
  else if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) errors.contact_email = 'Enter a valid email address, like shop@example.com.'

  if (phone) {
    const digits = phone.replace(/\D/g, '').length
    if (phone.length > PHONE_MAX || !PHONE_CHARS_RE.test(phone) || digits < 7) {
      errors.phone = 'Enter a valid phone number, or leave it blank.'
    }
  }
  return errors
}

// Only fields that actually changed, normalized (trimmed; blank phone → null).
export function changedFields(original: ShopDetailsDraft, draft: ShopDetailsDraft): ShopDetailsUpdate {
  const next = { name: draft.name.trim(), contact_email: draft.contact_email.trim(), phone: draft.phone.trim() || null }
  const prev = { name: original.name.trim(), contact_email: original.contact_email.trim(), phone: original.phone.trim() || null }
  const update: ShopDetailsUpdate = {}
  if (next.name !== prev.name) update.name = next.name
  if (next.contact_email !== prev.contact_email) update.contact_email = next.contact_email
  if (next.phone !== prev.phone) update.phone = next.phone
  return update
}

export const SHOP_DETAILS_CHANGED = 'specplus:shop-details-changed'
export type ShopDetailsChange = { shopId: string; name: string }

export function announceShopDetailsChange(change: ShopDetailsChange) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ShopDetailsChange>(SHOP_DETAILS_CHANGED, { detail: change }))
}

export function onShopDetailsChange(handler: (change: ShopDetailsChange) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ShopDetailsChange>).detail)
  window.addEventListener(SHOP_DETAILS_CHANGED, listener)
  return () => window.removeEventListener(SHOP_DETAILS_CHANGED, listener)
}
