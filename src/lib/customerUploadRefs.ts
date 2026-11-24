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
  return /^[^/]+\/[^/]+$/.test(ref) ? ref : null
}

export function customerUploadError(file: { type: string; size: number }): string | null {
  if (!CUSTOMER_UPLOAD_TYPES[file.type]) return 'Please choose a JPEG, PNG, WebP or HEIC photo.'
  if (file.size > CUSTOMER_UPLOAD_MAX_BYTES) return 'Image is too large (max 10MB).'
  return null
}

// Object name for a new upload: `<shop id>/<random uuid>.<ext from MIME type>`.
export function customerUploadObjectName(shopId: string, file: { type: string }, uuid: string = crypto.randomUUID()): string | null {
  const ext = CUSTOMER_UPLOAD_TYPES[file.type]
  return ext ? `${shopId}/${uuid}.${ext}` : null
}
