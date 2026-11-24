# Customer data privacy: build sheets and customer photos

Branch `fix/customer-data-privacy`. Covers two launch blockers: public build
sheets and public customer photos. Nothing in this document has been applied to
TEST or production.

## 1. Inventory (before this change)

### Build sheets (`public.build_sheets`, route `/build/:id`)

| Who | What | Where |
| --- | --- | --- |
| Reader, anonymous | `select('*')` by id. Policy `public_select_build_sheets` (`USING (true)`) plus `GRANT SELECT ... TO anon` let **anyone with the public anon key list every row**: customer names and emails, totals, photo URLs. | `src/pages/BuildSheet.tsx`, migrations `20260924015738`, `20260927210000` |
| Writer, staff | Lead page upserted a sheet, then emailed `/build/<sheet id>`. **Removed in PR #15 (6a0c0d1, 2026-10-04).** No code creates build sheets today. | (historical) `src/pages/LeadDetailPage.tsx` |
| Email sender | `send-build-sheet` Edge Function: sends whatever `buildUrl` and `customerEmail` the caller passes. **No caller in the app since PR #15.** `verify_jwt = true` is satisfied by the public anon key, so it is effectively an open relay for anyone with that key (see section 6). | `supabase/functions/send-build-sheet/index.ts` |

Existing `/build/` links exist only in emails sent before 2026-10-04.

### Customer photos (storage bucket `customer-uploads`)

| Who | What | Where |
| --- | --- | --- |
| Writer, anonymous | Custom-build flow uploads truck photos and per-part reference photos to `<shop id>/<uuid>.<ext from file name>`. Any extension, any size up to the project default. | `src/components/CustomBuildFlow.tsx` |
| Reader, anonymous | The same flow previews uploads with public URLs. | `CustomBuildFlow.tsx` |
| Reader, staff | Lead page (photos and reference links), pricing modal, quote builder and add-item editor, all through public URLs. | `LeadDetailPage.tsx`, `ShopCustomPricingModal.tsx`, `QuoteBuilderPage.tsx`, `QuoteBuildItemEditor.tsx` |
| Snapshot writer | Quote creation stores a **public URL** of the customer photo in `quotes.front_image_url` / `rear_image_url`. | `src/lib/quotes.ts` |
| Reader, customer | Quote page `/q/:token` shows those public URLs; old build-sheet page showed `build_sheets.front_image_url`. | `CustomerQuotePage.tsx`, `BuildSheet.tsx` |
| Storage policy | `customer_uploads_read`: anon and authenticated may **SELECT/list every object** in the bucket. The bucket is `public = true`. | migrations `20260919021806`, `20260927210000` |

Public and unchanged: `vehicles` (template vehicle images, paint-style images)
and `shop-logos`.

## 2. Exposure findings (flagged)

1. **Every existing build-sheet id is exposed.** The table was listable by anon,
   so a legitimate `/build/<id>` link from an email cannot be distinguished from
   an id harvested from the open table. **No existing link can be preserved
   safely.** All old links are retired: the page says the link is no longer
   active and asks the customer to request a new one.
2. **Every customer photo path is exposed.** Anyone could list the bucket
   through the Storage API, and build-sheet photo URLs were in the open table.
   Removing the listing policy and making the bucket private closes access to
   the files themselves. Previously harvested URLs stop working once the
   bucket is private (phase 2). Until then they still resolve, which is why
   phase 2 should follow phase 1 promptly.
3. `send-build-sheet` is unused but deployed and callable with the anon key
   (section 6).

### Replacement plan for retired build-sheet links

- Shops open the lead and use the new **Build sheet link** card: *Create share
  link* mints a scoped link `/build/<64 hex chars>`. *Replace link* rotates it
  (the old one stops working immediately), and *Turn off link* revokes it.
- For most customers the quote link (`/q/<token>`) already shows the same build
  with pricing. It is the preferred thing to resend.
- Optional: an admin can list affected customers with
  `SELECT shop_id, customer_name, customer_email, created_at FROM build_sheets`
  and the shop can contact them. **Do not send automatically.**

## 3. What changed

### Database: `supabase/migrations/20261124120000_customer_data_privacy.sql` (phase 1)

- Build sheets: removed the public SELECT policy and the anon grant. Staff read
  their own shop's sheets; admins read all.
- New `share_token` / `shared_at` columns. Existing rows start unshared.
- New functions:
  - `create_build_sheet_share_link(sheet_id)` / `revoke_build_sheet_share_link(sheet_id)`:
    owning shop or admin only.
  - `get_shared_build_sheet(token)`: anon. Returns customer-facing fields only:
    no ids, shop or lead ids, or customer email.
- A trigger refuses direct writes to `share_token`.
- Customer uploads:
  - The broad read/list policy is dropped.
  - Staff may read their own shop's folder; admins may read all.
  - Anonymous insert only to `<existing shop id>/<uuid>.<jpg|jpeg|png|webp|heic|heif>`.
  - The bucket enforces `file_size_limit = 10 MB` and image `allowed_mime_types`
    server-side.
- `customer_photo_paths(kind, token)` (service_role only): the customer-upload
  paths attached to a non-draft quote or a shared build sheet, limited to that
  record's own shop folder.

### Staged: `supabase/rollout/20261124130000_make_customer_uploads_private.sql` (phase 2)

`UPDATE storage.buckets SET public = false WHERE id = 'customer-uploads'`.
It is deliberately **not** in `supabase/migrations/`, so a routine `db push`
cannot flip the bucket before its readers are live. A follow-up PR moves it
into migrations.

### Edge Function: `supabase/functions/customer-photos` (new, `verify_jwt = false`)

`POST {kind: 'quote' | 'build_sheet', token}` returns 1-hour signed URLs for
the paths `customer_photo_paths()` allows. It never accepts paths from the
caller. Unknown tokens get an empty result.

### Frontend

- `src/lib/customerPhotos.ts`: one resolver for every customer-photo reference.
  - Staff get signed URLs, which Storage RLS only issues for their shop.
  - Customers get them through the Edge Function.
  - Public vehicle and logo URLs pass through unchanged.
- Custom-build flow:
  - Names uploads from the MIME type and checks type and size before upload.
  - Previews the visitor's own files locally, since visitors cannot read the
    private bucket.
- Staff pages (lead, pricing modal, quote builder) use signed URLs.
- Quote snapshots now store the object path. Older quotes hold public-URL-shaped
  values, which resolve the same way.
- `/build/:token` uses `get_shared_build_sheet`. Legacy uuid links show a
  "no longer active" message.
- Lead page: new **Build sheet link** card (`BuildSheetShareControl`).

## 4. Rollout order (TEST first, then production)

Each step is a manual action by someone with access. None was performed here.

0. **Pre-check hosted storage policies.** In the target project, list
   `storage.objects` policies that mention `customer-uploads`, or that apply
   to all buckets. Any policy created in the dashboard that grants anon or
   authenticated SELECT must be dropped in step 1, or the bucket stays
   listable. Record the current `storage.buckets` row for `customer-uploads`.
1. **Apply phase 1** (`20261124120000_customer_data_privacy.sql`). This is
   compatible with the current frontend:
   - Anon listing of sheets and photos stops.
   - Old `/build/` links stop working (intended).
   - Staff and customer photos keep loading, because the bucket is still public.
   - Uploads under the old frontend still work for normal photos. A file whose
     name has no image extension (for example `photo` or `.gif`) is refused
     until step 3, so keep the gap between steps 1 and 3 short.
2. **Deploy the `customer-photos` Edge Function** with `verify_jwt = false`
   (from `supabase/config.toml`).
3. **Deploy the frontend** (merge the reviewed PR; Vercel deploys `main`).
4. **Verify on the environment** (see section 5) while the bucket is still public.
5. **Phase 2:** move `supabase/rollout/20261124130000_make_customer_uploads_private.sql`
   into `supabase/migrations/` in a follow-up PR, then apply it.
6. **Verify again**:
   - `/storage/v1/object/public/customer-uploads/<path>` now fails.
   - Staff lead and quote pages show photos.
   - A customer quote with custom photos shows them.
   - A shared build sheet shows its photos.
7. **Notify shops** about retired build-sheet links and the new Build sheet link
   card. Shops contact customers; nothing is sent automatically.

### Rollback (never reopens broad public access)

- **Never** re-add `public_select_build_sheets`, the anon SELECT grant on
  `build_sheets`, the `customer_uploads_read` policy, or `public = true` on
  `customer-uploads`.
- After step 1, if uploads fail broadly: relax only the INSERT check in
  `customer_upload_path_allowed()`, for example by allowing more extensions in
  a new migration. Do not add any read access.
- Steps 2 and 3: roll forward with a fix rather than back. Redeploying the
  previous frontend keeps working only while the bucket is still public; after
  phase 2 it shows no customer photos (fails closed).
- After phase 2, if the function or signing fails:
  - Staff still load photos, because staff signed URLs come straight from
    Storage RLS.
  - Customer quote pages and shared build sheets render without photos until
    the function is fixed.
  - Disabling sharing (`revoke_build_sheet_share_link`) is always safe.

## 5. Verification checklist (per environment, synthetic data only)

- Anon cannot list build sheets:
  `GET /rest/v1/build_sheets?select=*` with the anon key returns a permission error.
- Anon `storage.list('customer-uploads')` returns nothing.
- Staff of shop A cannot read shop B's sheets or sign shop B's photos.
- A shared build sheet opens signed-out, shows only customer fields, and its
  photos load. *Replace link* breaks the old link.
- An old `/build/<uuid>` link shows the "no longer active" message.
- Custom request signed-out:
  - JPEG/PNG upload succeeds and previews.
  - An SVG or over-10 MB file is refused by Storage.
  - The lead is created.
- Staff see the custom photos, then create and send a quote. The customer quote
  page shows the photos.
- Preconfigured quote: vehicle template images still load publicly.
- Shop logos still load.

Automated equivalents run in `tests/customerDataPrivacy.db.test.ts` (PGlite)
and `tests/customerPhotos.test.ts` (helpers and Edge Function). Storage API
behaviour is not part of the local harness and must be checked on TEST:
- that `file_size_limit` and `allowed_mime_types` are enforced,
- that an `upsert: false` upload needs only INSERT,
- that signed URLs work while the bucket is private.

## 6. Out of scope, recommended follow-ups

- `send-build-sheet`: unused, and callable with the public anon key to email
  any address with any link. Recommend undeploying it, or requiring a staff
  session and building the link server-side. Left for the notifications work.
- Orphaned uploads (files never attached to a lead) are not cleaned up.
