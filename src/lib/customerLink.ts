// The shop's shareable quote-request link (pure; unit tested).

export const DEFAULT_PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'

// VITE_PUBLIC_QUOTE_ORIGIN when it is a valid http(s) origin, otherwise the
// default. Paths and trailing slashes are ignored.
export function publicQuoteOrigin(configured: string | undefined | null): string {
  const value = configured?.trim()
  if (!value) return DEFAULT_PUBLIC_QUOTE_ORIGIN
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : DEFAULT_PUBLIC_QUOTE_ORIGIN
  } catch {
    return DEFAULT_PUBLIC_QUOTE_ORIGIN
  }
}

// /{slug} when the shop has one, otherwise the legacy /customize/{shop_id}.
export function customerLinkFor(origin: string, shop: { id: string; slug: string | null | undefined }): string {
  const slug = shop.slug?.trim()
  return slug ? `${origin}/${encodeURIComponent(slug)}` : `${origin}/customize/${shop.id}`
}

// Copies with the Clipboard API, falling back to the selection-based copy
// some Android browsers and non-secure contexts still need.
export async function copyText(
  text: string,
  deps: { writeText?: (text: string) => Promise<void>; fallbackCopy?: () => boolean },
): Promise<boolean> {
  if (deps.writeText) {
    try {
      await deps.writeText(text)
      return true
    } catch {
      // Permission denied or unavailable: try the fallback.
    }
  }
  try {
    return deps.fallbackCopy?.() ?? false
  } catch {
    return false
  }
}
