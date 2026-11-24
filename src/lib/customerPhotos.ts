// Customer-uploaded photos live in the private `customer-uploads` bucket.
// Nothing here builds a public URL for them:
// - staff get short-lived signed URLs, which Storage only issues for their own
//   shop's folder (RLS policy customer_uploads_staff_read);
// - customers get signed URLs from the customer-photos Edge Function, only for
//   the photos attached to the quote or shared build sheet they opened;
// - the anonymous upload flow previews the visitor's own files locally.
// Public vehicle template images and shop logos are passed through unchanged.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import { CUSTOMER_UPLOADS_BUCKET, SIGNED_URL_TTL_SECONDS, customerUploadPath, type PhotoAccess } from './customerUploadRefs'

export {
  CUSTOMER_UPLOADS_BUCKET, CUSTOMER_UPLOAD_MAX_BYTES, CUSTOMER_UPLOAD_TYPES, SIGNED_URL_TTL_SECONDS, STAFF_PHOTO_ACCESS,
  customerUploadError, customerUploadObjectName, customerUploadPath,
} from './customerUploadRefs'
export type { PhotoAccess } from './customerUploadRefs'

type PhotoClient = Pick<typeof supabase, 'storage' | 'functions'>

export async function fetchCustomerPhotoUrls(
  paths: string[],
  access: PhotoAccess,
  client: PhotoClient = supabase,
): Promise<Record<string, string>> {
  if (access.mode === 'staff') {
    if (paths.length === 0) return {}
    const { data, error } = await client.storage.from(CUSTOMER_UPLOADS_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
    if (error) throw error
    const out: Record<string, string> = {}
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl && !entry.error) out[entry.path] = entry.signedUrl
    }
    return out
  }
  const { data, error } = await client.functions.invoke('customer-photos', {
    body: { kind: access.mode, token: access.token },
  })
  if (error) throw error
  const photos = (data as { photos?: Record<string, unknown> } | null)?.photos ?? {}
  const out: Record<string, string> = {}
  for (const [path, url] of Object.entries(photos)) {
    if (typeof url === 'string') out[path] = url
  }
  return out
}

// Resolves photo references to displayable URLs. Customer uploads resolve to
// signed URLs (null while loading or when not authorized); other http(s) URLs
// pass through unchanged.
export function useCustomerPhotos(
  refs: (string | null | undefined)[],
  access: PhotoAccess | null,
): (ref: string | null | undefined) => string | null {
  const paths = useMemo(
    () => Array.from(new Set(refs.map(customerUploadPath).filter((p): p is string => !!p))).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refs.join('\n')],
  )
  const key = paths.join('\n')
  const accessKey = access ? `${access.mode}:${'token' in access ? access.token : ''}` : ''
  const [signed, setSigned] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!access || paths.length === 0) {
      setSigned({})
      return
    }
    let active = true
    fetchCustomerPhotoUrls(paths, access)
      .then((urls) => { if (active) setSigned(urls) })
      .catch((err) => {
        console.error('Could not load customer photos:', err instanceof Error ? err.message : err)
        if (active) setSigned({})
      })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accessKey])

  return (ref) => {
    if (!ref) return null
    const path = customerUploadPath(ref)
    if (path) return signed[path] ?? null
    return /^https?:\/\//i.test(ref) ? ref : null
  }
}
