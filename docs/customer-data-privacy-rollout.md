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
  paths attached to a non-draft quote or a shared build sheet. Tightened by the
  next migration so a shop folder alone is not enough.

### Database: `supabase/migrations/20261125120000_bind_customer_photos_to_requests.sql`

A matching shop folder does not prove a photo belongs to the request behind a
quote or build sheet. Lead photo fields are written by anonymous customers,
and every path used to be listable. A customer who referenced another
customer's path in their own request could then see it through their own
quote link. This migration binds every photo a customer can see to one request.

- **New uploads.**
  - The custom-build flow creates a random 64-hex **upload key** per request,
    and uploads to `<shop id>/<upload ref>/<uuid>.<ext>`, where
    `upload ref = first 32 hex of sha256(key)`.
  - The request is submitted with `upload_key`. A trigger stores only
    `leads.upload_ref` and discards the key. A CHECK constraint guarantees the
    key is never stored.
  - `upload_ref` cannot be set by callers or changed later, including by staff.
  - A path reveals the ref but not the key, so no other request can claim it.
- **Customer visibility.** `customer_photo_paths()` returns a referenced path
  only if it belongs to the record's own lead, which must be in the same shop.
  That means either:
  - a keyed path whose ref equals the lead's `upload_ref`, or
  - a legacy path that a staff member explicitly shared with that lead.

  Build sheets with no linked lead show no customer photos.
- **Existing (legacy) photos** `<shop id>/<uuid>.<ext>` are **staff-only**.
  - There is **no automatic matching**: not by upload time, and not by "only one
    request references it". While every path was listable, someone else could
    have arranged either signal, so neither proves ownership. The migration
    shares nothing.
  - The shop's staff and admins still see every legacy photo on the lead and
    quote pages (shop-folder Storage policy). Customer links do not show them.
  - A staff member can **explicitly share** one legacy photo with one request's
    customer after verifying it (section 4a):
    - `share_legacy_customer_photo(lead, path)`;
    - `unshare_legacy_customer_photo(lead, path)` to undo.
  - Shares are recorded in `legacy_customer_photo_shares` with who shared and
    when. Staff of the shop can read that table; nobody can write it directly.
  - A share works only for a legacy photo that the request itself references,
    in its own shop, and that exists in Storage. Sharing with one request never
    exposes the photo to any other request.
  - `lead_legacy_photos(lead)` lists a lead's legacy photos, whether each is
    shared, and how many **other** requests reference it.
- **Uploads during rollout.** The two-level legacy layout is still accepted
  for anonymous uploads, so the currently deployed frontend keeps working
  between steps 1 and 3. Those photos are staff-only like any legacy photo, and
  staff can share them explicitly. Remove the legacy layout from
  `customer_upload_path_allowed()` in the phase-2 PR.

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
  - Uploads under the request's upload ref, and submits the request with the
    upload key.
  - Previews the visitor's own files locally, since visitors cannot read the
    private bucket.
- Staff pages (lead, pricing modal, quote builder) use signed URLs.
- Quote snapshots now store the object path. Older quotes hold public-URL-shaped
  values, which resolve the same way.
- `/build/:token` uses `get_shared_build_sheet`. Legacy uuid links show a
  "no longer active" message.
- Lead page: new **Build sheet link** card (`BuildSheetShareControl`).
- Lead page: new **Older customer photos** panel (`LegacyPhotoSharing`) on custom
  requests that have legacy photos:
  - each photo is marked *Staff only* or *Shown to customer*;
  - a warning appears when other requests reference the same photo;
  - *Show to customer* asks for confirmation; *Stop showing* undoes it.

## 4. Rollout order (TEST first, then production)

Each step is a manual action by someone with access. None was performed here.

0. **Pre-check hosted storage policies.** In the target project, list
   `storage.objects` policies that mention `customer-uploads`, or that apply
   to all buckets. Any policy created in the dashboard that grants anon or
   authenticated SELECT must be dropped in step 1, or the bucket stays
   listable. Record the current `storage.buckets` row for `customer-uploads`.
1. **Apply phase 1 and the binding migration** (`20261124120000_customer_data_privacy.sql`,
   then `20261125120000_bind_customer_photos_to_requests.sql`). This is
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
   From this step on, customer links stop showing legacy photos. Tell shops
   about the *Older customer photos* panel (step 7).
5. **Phase 2:** move `supabase/rollout/20261124130000_make_customer_uploads_private.sql`
   into `supabase/migrations/` in a follow-up PR, then apply it. In the same
   PR, stop accepting the legacy two-level upload layout.
6. **Verify again**:
   - `/storage/v1/object/public/customer-uploads/<path>` now fails.
   - Staff lead and quote pages show photos.
   - A customer quote with custom photos shows them.
   - A shared build sheet shows its photos.
7. **Notify shops** about retired build-sheet links, the new Build sheet link
   card, and that older photos are now staff-only, with the re-share
   procedure in section 4a. Shops contact customers; nothing is sent
   automatically.

### 4a. Verifying and re-sharing a legacy photo (staff procedure)

Use this only when a customer needs to see an older photo on their quote or
build-sheet link.

1. Open the request in the dashboard. The *Older customer photos* panel shows
   the request's legacy photos; open a photo to view it.
2. Check the warning. *Also on N other requests* means the same photo is
   attached to another request. Treat that as a possible mix-up or misuse,
   and do not share it unless the next step settles it.
3. Confirm with the customer through a channel you already trust: call the
   phone number on the request, or ask them to reply from the email address on
   the request and describe the photo (vehicle, color, angle). Do not rely on a
   link, a photo path, or an email from a different address.
4. If they confirm, click **Show to customer** and accept the prompt. Only that
   photo becomes visible, and only on links for this request. The share is
   recorded with your user and the time.
5. If in doubt, leave it staff-only. Alternatively, ask the customer to submit
   a new request with fresh photos; new uploads are bound to their request
   automatically.
6. To undo, click **Stop showing**. Customer links stop showing the photo once
   their signed URL expires, within an hour.

Admins can audit shares with
`SELECT * FROM legacy_customer_photo_shares ORDER BY shared_at DESC`.

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
- Two synthetic customers of the same shop each submit a custom request with
  photos. Customer B's quote link shows only B's photos, even if B's request
  references A's photo paths.
- The new lead row has `upload_ref` set and `upload_key` empty, and its photos
  sit under `<shop>/<upload_ref>/`.
- A quote for a lead submitted before the migration shows **no** legacy photos
  to the customer. Staff still see them on the lead page, in the *Older
  customer photos* panel.
- After *Show to customer* on one legacy photo, the customer link shows exactly
  that photo. *Stop showing* removes it again.
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
