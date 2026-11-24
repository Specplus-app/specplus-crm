// Pure helpers for customer-uploaded photos (no Supabase client), shared by
// the app and tests. customerUploadPath() mirrors the database function
// customer_upload_object_path().
export const CUSTOMER_UPLOADS_BUCKET = 'customer-uploads'
export const CUSTOMER_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const SIGNED_URL_TTL_SECONDS = 60 * 60

// Matches the bucket's allowed_mime_types and customer_upload_path_allowed().
export const CUSTOMER_UPLOAD_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

export type PhotoAccess =
  | { mode: 'staff' }
  | { mode: 'quote'; token: string }
  | { mode: 'build_sheet'; token: string }

export const STAFF_PHOTO_ACCESS: PhotoAccess = { mode: 'staff' }

const OBJECT_URL_RE = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/customer-uploads\/([^?#]+)/

// Same rule as customer_upload_object_path() in the database: a bare object
// path, or a public/signed URL of the customer-uploads bucket. Anything else
// (for example a public vehicle image URL) is not a customer upload.
export function customerUploadPath(ref: string | null | undefined): string | null {
  if (!ref) return null
  if (/^https?:\/\//i.test(ref)) {
    const m = OBJECT_URL_RE.exec(ref)
    return m && m[1] ? decodeURIComponent(m[1]) : null
  }
  return /^[^/]+\/[^/]+(\/[^/]+)?$/.test(ref) ? ref : null
}

export function customerUploadError(file: { type: string; size: number }): string | null {
  if (!CUSTOMER_UPLOAD_TYPES[file.type]) return 'Please choose a JPEG, PNG, WebP or HEIC photo.'
  if (file.size > CUSTOMER_UPLOAD_MAX_BYTES) return 'Image is too large (max 10MB).'
  return null
}

// Each custom request gets a random upload key. Its photos are stored under
// <shop id>/<upload ref>/, where upload ref = first 32 hex chars of
// sha256(key). The request is submitted with the key; the database keeps only
// the ref (customer_upload_ref()), so knowing a photo path never lets another
// request claim it.
export function newUploadKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function customerUploadRef(uploadKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uploadKey))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

// Object name for a new upload: `<shop id>/<upload ref>/<random uuid>.<ext from MIME type>`.
export function customerUploadObjectName(
  shopId: string,
  uploadRef: string,
  file: { type: string },
  uuid: string = crypto.randomUUID(),
): string | null {
  const ext = CUSTOMER_UPLOAD_TYPES[file.type]
  return ext && /^[0-9a-f]{32}$/.test(uploadRef) ? `${shopId}/${uploadRef}/${uuid}.${ext}` : null
}
