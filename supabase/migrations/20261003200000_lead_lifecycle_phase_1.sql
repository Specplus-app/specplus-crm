/*
# Lead Lifecycle Phase 1: quotes, customer engagement tracking, audit trail

1. Lead lifecycle
   - Expands `leads.status` to: new, contacted, quoting, quote_sent, viewed,
     approved, scheduling, scheduled, in_progress, completed, declined, lost, archived.
   - Migrates legacy `quoted` leads to `quote_sent`. `quoted` itself remains a
     temporarily accepted legacy value for a backend-first rollout (see below).
   - Adds `leads_status_check`. It is created NOT VALID and only validated when
     every existing row already conforms, so unexpected legacy values cannot
     block the migration (they are reported with a NOTICE instead).
   - Unauthenticated (public customizer) lead submissions always start as `new`.

2. New tables
   - `quotes`: one row per quote revision. Drafts are editable by the owning
     shop; once sent, the commercial snapshot is immutable. Revisions are new
     rows that point at the quote they supersede.
   - `quote_views`: one row per customer browser session that viewed a quote,
     so repeated renders/reloads in the same session never inflate view_count.
   - `lead_events`: immutable, append-only lead audit trail.

3. Database-enforced behavior (independent of any UI)
   - Quote totals are recomputed by the database while a quote is a draft:
       taxable subtotal = max(parts_total + custom_lines_total - discount, 0)
       tax_total        = round(taxable subtotal * tax_rate / 100, 2)
       grand_total      = taxable subtotal + tax_total + shipping_total
   - Sent quotes cannot have their commercial snapshot changed.
   - Quote status may only move draft -> sent -> viewed -> approved/declined
     (sent may also go straight to approved/declined).
   - Lead lifecycle auto-advances on quote create/send/view/approve/decline.
   - Audit events are written by triggers for lead creation, every lead status
     change (manual or automatic), and quote created/revised/sent/viewed/
     approved/declined.

4. Security
   - RLS on all new tables. Admins read everything; shop users only see rows
     belonging to their own shop. Anonymous users have no table access.
   - Authenticated clients may only INSERT/UPDATE the editable draft columns of
     `quotes` (column grants). Status, engagement and computed totals can only be
     changed by the SECURITY DEFINER functions/triggers below.
   - Nobody receives INSERT/UPDATE/DELETE grants on `lead_events` or
     `quote_views`; `lead_events` rows additionally reject UPDATE via trigger.
   - Public customer access is only through:
       get_public_quote(token)                  -- anon, authenticated
       record_quote_view(token, view_session)   -- anon, authenticated
       respond_to_quote(token, response)        -- anon, authenticated
     and the send-quote Edge Function uses:
       mark_quote_sent(quote_id, actor_id)      -- service_role only
   - All SECURITY DEFINER functions use `SET search_path = ''` and fully
     qualified object names, with explicit EXECUTE revokes/grants.
*/

BEGIN;

-- ===========================================================================
-- 1. Lead lifecycle statuses
-- ===========================================================================

-- Runs before the audit triggers exist, so the data migration does not create
-- status_changed events.
UPDATE public.leads SET status = 'quote_sent' WHERE status = 'quoted';

-- TEMPORARY LEGACY COMPATIBILITY: `quoted` is still accepted so the backend can
-- be installed before the new frontend ships. The previously deployed frontend
-- can still write `quoted` during that rollout window, and it must not hit a
-- constraint error. The new frontend never offers `quoted`. Once the new
-- frontend is fully deployed, a later cleanup migration can convert any
-- remaining `quoted` rows to `quote_sent` and drop `quoted` from this list.
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check CHECK (status IN (
    'new', 'contacted', 'quoted', 'quoting', 'quote_sent', 'viewed', 'approved',
    'scheduling', 'scheduled', 'in_progress', 'completed', 'declined', 'lost', 'archived'
  )) NOT VALID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.leads
    WHERE status NOT IN (
      'new', 'contacted', 'quoted', 'quoting', 'quote_sent', 'viewed', 'approved',
      'scheduling', 'scheduled', 'in_progress', 'completed', 'declined', 'lost', 'archived'
    )
  ) THEN
    RAISE NOTICE 'leads_status_check left NOT VALID: some existing leads have unrecognized status values';
  ELSE
    ALTER TABLE public.leads VALIDATE CONSTRAINT leads_status_check;
  END IF;
END;
$$;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  supersedes_quote_id uuid REFERENCES public.quotes(id) ON DELETE CASCADE,
  superseded_at timestamptz,
  public_token uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'approved', 'declined')),

  -- Commercial snapshot
  selected_parts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(selected_parts) = 'array'),
  custom_line_items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(custom_line_items) = 'array' AND jsonb_array_length(custom_line_items) <= 100),
  parts_total numeric(12, 2) NOT NULL DEFAULT 0 CHECK (parts_total >= 0),
  custom_lines_total numeric(12, 2) NOT NULL DEFAULT 0 CHECK (custom_lines_total >= 0),
  shipping_total numeric(12, 2) NOT NULL DEFAULT 0 CHECK (shipping_total >= 0),
  discount_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_rate numeric(6, 3) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_total numeric(12, 2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total numeric(12, 2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  estimated_lead_time_days integer NOT NULL DEFAULT 0 CHECK (estimated_lead_time_days >= 0),
  customer_notes text CHECK (customer_notes IS NULL OR char_length(customer_notes) <= 5000),
  internal_notes text CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 5000),
  expires_at date,
  front_image_url text,
  rear_image_url text,

  -- Engagement
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  approved_at timestamptz,
  declined_at timestamptz,

  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quotes_public_token_key UNIQUE (public_token),
  CONSTRAINT quotes_lead_revision_key UNIQUE (lead_id, revision_number),
  CONSTRAINT quotes_sent_requires_sent_at CHECK (status = 'draft' OR sent_at IS NOT NULL),
  CONSTRAINT quotes_not_self_superseding CHECK (supersedes_quote_id IS DISTINCT FROM id)
);

CREATE INDEX IF NOT EXISTS idx_quotes_lead_id ON public.quotes(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_shop_id ON public.quotes(shop_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON public.quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_supersedes_quote_id ON public.quotes(supersedes_quote_id);
-- v1: at most one open draft per lead.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_draft_per_lead
  ON public.quotes(lead_id) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS public.quote_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  view_session_id text NOT NULL
    CHECK (char_length(view_session_id) BETWEEN 8 AND 128),
  viewed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_views_quote_session_key UNIQUE (quote_id, view_session_id)
);

CREATE TABLE IF NOT EXISTS public.lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE CASCADE,
  -- Free-form snake_case so later phases (followup_sent, booking_selected, ...)
  -- need no schema change.
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'shop_user', 'admin', 'system')),
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead_created ON public.lead_events(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_events_shop_created ON public.lead_events(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_events_quote_id ON public.lead_events(quote_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_event_type ON public.lead_events(event_type);

-- ===========================================================================
-- 3. Audit helpers (internal; not executable by clients)
-- ===========================================================================

-- Resolves who is performing the current action. Controlled functions acting on
-- someone's behalf (public quote RPCs, the send-quote Edge Function) set the
-- transaction-local `specplus.actor_type` / `specplus.actor_id` settings first.
CREATE OR REPLACE FUNCTION public.lead_event_actor(OUT actor_type text, OUT actor_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_override text := nullif(current_setting('specplus.actor_type', true), '');
  v_uid uuid;
  v_role text;
  v_claims text;
BEGIN
  IF v_override IN ('customer', 'shop_user', 'admin', 'system') THEN
    actor_type := v_override;
    actor_id := nullif(current_setting('specplus.actor_id', true), '')::uuid;
    RETURN;
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;
    actor_type := CASE v_role WHEN 'admin' THEN 'admin' WHEN 'shop_user' THEN 'shop_user' ELSE 'system' END;
    actor_id := v_uid;
    RETURN;
  END IF;

  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  IF v_claims IS NOT NULL AND (v_claims::jsonb ->> 'role') = 'anon' THEN
    actor_type := 'customer';
  ELSE
    actor_type := 'system';
  END IF;
  actor_id := NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_lead_event(
  p_lead_id uuid,
  p_quote_id uuid,
  p_event_type text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_shop_id uuid;
  v_actor_type text;
  v_actor_id uuid;
BEGIN
  SELECT l.shop_id INTO v_shop_id FROM public.leads l WHERE l.id = p_lead_id;
  IF v_shop_id IS NULL THEN
    RETURN;
  END IF;

  SELECT a.actor_type, a.actor_id INTO v_actor_type, v_actor_id
  FROM public.lead_event_actor() a;

  INSERT INTO public.lead_events (lead_id, shop_id, quote_id, event_type, actor_type, actor_id, metadata)
  VALUES (p_lead_id, v_shop_id, p_quote_id, p_event_type, v_actor_type, v_actor_id, coalesce(p_metadata, '{}'::jsonb));
END;
$$;

-- True when the current authenticated user is an admin or belongs to the shop.
-- Used so staff previewing a customer link do not count as customer views.
CREATE OR REPLACE FUNCTION public.quote_viewer_is_staff(p_shop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (p.role = 'admin' OR (p.role = 'shop_user' AND p.shop_id = p_shop_id))
  );
$$;

-- ===========================================================================
-- 4. Lead triggers
-- ===========================================================================

-- Public customizer submissions always start at the beginning of the lifecycle.
CREATE OR REPLACE FUNCTION public.leads_before_insert_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    NEW.status := 'new';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_before_insert_status ON public.leads;
CREATE TRIGGER leads_before_insert_status
  BEFORE INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_before_insert_status();

CREATE OR REPLACE FUNCTION public.leads_audit_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.record_lead_event(NEW.id, NULL, 'lead_created', jsonb_build_object('status', NEW.status));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS leads_audit_insert ON public.leads;
CREATE TRIGGER leads_audit_insert
  AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_audit_insert();

CREATE OR REPLACE FUNCTION public.leads_audit_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.record_lead_event(
    NEW.id, NULL, 'status_changed',
    jsonb_build_object('from', OLD.status, 'to', NEW.status)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS leads_audit_status_change ON public.leads;
CREATE TRIGGER leads_audit_status_change
  AFTER UPDATE OF status ON public.leads
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.leads_audit_status_change();

-- ===========================================================================
-- 5. Quote triggers
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.quotes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lead_shop_id uuid;
  v_max_revision integer;
  v_prev public.quotes%ROWTYPE;
  v_parts numeric;
  v_custom numeric;
  v_taxable numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Lock the lead so concurrent creates/revisions get distinct revision numbers.
    SELECT l.shop_id INTO v_lead_shop_id FROM public.leads l WHERE l.id = NEW.lead_id FOR UPDATE;
    IF v_lead_shop_id IS NULL THEN
      RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.shop_id := v_lead_shop_id;

    SELECT max(q.revision_number) INTO v_max_revision FROM public.quotes q WHERE q.lead_id = NEW.lead_id;

    IF v_max_revision IS NULL THEN
      IF NEW.supersedes_quote_id IS NOT NULL THEN
        RAISE EXCEPTION 'The quote being revised does not belong to this lead' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW.supersedes_quote_id IS NULL THEN
        RAISE EXCEPTION 'This lead already has a quote; create a revision instead' USING ERRCODE = 'check_violation';
      END IF;
      SELECT * INTO v_prev FROM public.quotes q WHERE q.id = NEW.supersedes_quote_id;
      IF NOT FOUND OR v_prev.lead_id <> NEW.lead_id THEN
        RAISE EXCEPTION 'The quote being revised does not belong to this lead' USING ERRCODE = 'check_violation';
      END IF;
      IF v_prev.revision_number <> v_max_revision THEN
        RAISE EXCEPTION 'Only the latest quote revision can be revised' USING ERRCODE = 'check_violation';
      END IF;
      IF v_prev.status = 'draft' THEN
        RAISE EXCEPTION 'Send or edit the current draft instead of revising it' USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    NEW.revision_number := coalesce(v_max_revision, 0) + 1;
    NEW.status := 'draft';
    NEW.superseded_at := NULL;
    NEW.sent_at := NULL;
    NEW.first_viewed_at := NULL;
    NEW.last_viewed_at := NULL;
    NEW.view_count := 0;
    NEW.approved_at := NULL;
    NEW.declined_at := NULL;
    NEW.created_by := auth.uid();
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    IF NEW.id <> OLD.id
      OR NEW.lead_id <> OLD.lead_id
      OR NEW.shop_id <> OLD.shop_id
      OR NEW.revision_number <> OLD.revision_number
      OR NEW.supersedes_quote_id IS DISTINCT FROM OLD.supersedes_quote_id
      OR NEW.public_token <> OLD.public_token
      OR NEW.created_at <> OLD.created_at
      OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
    THEN
      RAISE EXCEPTION 'Quote identity fields cannot be changed' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'draft' AND NEW.status = 'sent')
      OR (OLD.status = 'sent' AND NEW.status IN ('viewed', 'approved', 'declined'))
      OR (OLD.status = 'viewed' AND NEW.status IN ('approved', 'declined'))
    ) THEN
      RAISE EXCEPTION 'Invalid quote status transition from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status <> 'draft' AND (
      NEW.selected_parts, NEW.custom_line_items, NEW.parts_total, NEW.custom_lines_total,
      NEW.shipping_total, NEW.discount_amount, NEW.tax_rate, NEW.tax_total, NEW.grand_total,
      NEW.estimated_lead_time_days, NEW.customer_notes, NEW.internal_notes, NEW.expires_at,
      NEW.front_image_url, NEW.rear_image_url
    ) IS DISTINCT FROM (
      OLD.selected_parts, OLD.custom_line_items, OLD.parts_total, OLD.custom_lines_total,
      OLD.shipping_total, OLD.discount_amount, OLD.tax_rate, OLD.tax_total, OLD.grand_total,
      OLD.estimated_lead_time_days, OLD.customer_notes, OLD.internal_notes, OLD.expires_at,
      OLD.front_image_url, OLD.rear_image_url
    ) THEN
      RAISE EXCEPTION 'A sent quote cannot be changed; create a revision instead' USING ERRCODE = 'check_violation';
    END IF;

    IF (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
      OR (OLD.first_viewed_at IS NOT NULL AND NEW.first_viewed_at IS DISTINCT FROM OLD.first_viewed_at)
      OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
      OR (OLD.declined_at IS NOT NULL AND NEW.declined_at IS DISTINCT FROM OLD.declined_at)
      OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
      OR NEW.view_count < OLD.view_count
    THEN
      RAISE EXCEPTION 'Quote history fields cannot be rewritten' USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
  END IF;

  -- Deterministic totals, recomputed whenever the commercial snapshot may change.
  IF TG_OP = 'INSERT' OR OLD.status = 'draft' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.selected_parts) e WHERE jsonb_typeof(e) <> 'object'
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.custom_line_items) e WHERE jsonb_typeof(e) <> 'object'
    ) THEN
      RAISE EXCEPTION 'Quote line items must be objects' USING ERRCODE = 'check_violation';
    END IF;

    SELECT coalesce(sum(greatest(
      CASE WHEN jsonb_typeof(e -> 'price') = 'number' THEN (e ->> 'price')::numeric ELSE 0 END,
      0)), 0)
    INTO v_parts
    FROM jsonb_array_elements(NEW.selected_parts) e;

    SELECT coalesce(sum(round(
      greatest(CASE WHEN jsonb_typeof(e -> 'quantity') = 'number' THEN (e ->> 'quantity')::numeric ELSE 0 END, 0)
      * greatest(CASE WHEN jsonb_typeof(e -> 'unit_price') = 'number' THEN (e ->> 'unit_price')::numeric ELSE 0 END, 0),
      2)), 0)
    INTO v_custom
    FROM jsonb_array_elements(NEW.custom_line_items) e;

    NEW.parts_total := round(v_parts, 2);
    NEW.custom_lines_total := round(v_custom, 2);
    v_taxable := greatest(NEW.parts_total + NEW.custom_lines_total - NEW.discount_amount, 0);
    NEW.tax_total := round(v_taxable * NEW.tax_rate / 100, 2);
    NEW.grand_total := round(v_taxable + NEW.tax_total + NEW.shipping_total, 2);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotes_before_write ON public.quotes;
CREATE TRIGGER quotes_before_write
  BEFORE INSERT OR UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_before_write();

-- Lifecycle side effects + business audit events. Each branch fires only on a
-- state transition (OLD vs NEW), so an event is never recorded twice.
CREATE OR REPLACE FUNCTION public.quotes_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev_revision integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.supersedes_quote_id IS NULL THEN
      PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'quote_created',
        jsonb_build_object('revision_number', NEW.revision_number));
    ELSE
      SELECT q.revision_number INTO v_prev_revision FROM public.quotes q WHERE q.id = NEW.supersedes_quote_id;
      PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'quote_revised',
        jsonb_build_object(
          'revision_number', NEW.revision_number,
          'previous_quote_id', NEW.supersedes_quote_id,
          'previous_revision_number', v_prev_revision
        ));
    END IF;

    UPDATE public.leads
    SET status = 'quoting'
    WHERE id = NEW.lead_id
      AND status IN ('new', 'contacted', 'declined', 'lost');

    RETURN NULL;
  END IF;

  -- Sent
  IF OLD.status = 'draft' AND NEW.status = 'sent' THEN
    UPDATE public.quotes
    SET superseded_at = now()
    WHERE lead_id = NEW.lead_id
      AND id <> NEW.id
      AND revision_number < NEW.revision_number
      AND status <> 'draft'
      AND superseded_at IS NULL;

    PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'quote_sent',
      jsonb_build_object(
        'revision_number', NEW.revision_number,
        'grand_total', NEW.grand_total,
        'expires_at', NEW.expires_at
      ));

    UPDATE public.leads
    SET status = 'quote_sent'
    WHERE id = NEW.lead_id
      AND status NOT IN ('quote_sent', 'scheduling', 'scheduled', 'in_progress', 'completed', 'archived');
  END IF;

  -- New unique customer view
  IF NEW.view_count > OLD.view_count THEN
    PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'quote_viewed',
      jsonb_build_object(
        'revision_number', NEW.revision_number,
        'view_count', NEW.view_count,
        'first_view', OLD.view_count = 0
      ));
  END IF;

  IF OLD.status = 'sent' AND NEW.status = 'viewed' AND NEW.superseded_at IS NULL THEN
    UPDATE public.leads SET status = 'viewed' WHERE id = NEW.lead_id AND status = 'quote_sent';
  END IF;

  -- Approved
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'quote_approved',
      jsonb_build_object('revision_number', NEW.revision_number, 'grand_total', NEW.grand_total));
    UPDATE public.leads
    SET status = 'approved'
    WHERE id = NEW.lead_id
      AND status NOT IN ('approved', 'scheduling', 'scheduled', 'in_progress', 'completed');
  END IF;

  -- Declined
  IF NEW.status = 'declined' AND OLD.status <> 'declined' THEN
    PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'quote_declined',
      jsonb_build_object('revision_number', NEW.revision_number, 'grand_total', NEW.grand_total));
    UPDATE public.leads
    SET status = 'declined'
    WHERE id = NEW.lead_id
      AND status NOT IN ('declined', 'scheduling', 'scheduled', 'in_progress', 'completed');
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS quotes_after_write ON public.quotes;
CREATE TRIGGER quotes_after_write
  AFTER INSERT OR UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_after_write();

-- Audit history is append-only. DELETE is not blocked here so that deleting a
-- lead (an existing shop/admin capability) still cascades cleanly.
CREATE OR REPLACE FUNCTION public.lead_events_prevent_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Lead events are immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS lead_events_prevent_update ON public.lead_events;
CREATE TRIGGER lead_events_prevent_update
  BEFORE UPDATE ON public.lead_events
  FOR EACH ROW EXECUTE FUNCTION public.lead_events_prevent_update();

-- ===========================================================================
-- 6. Public customer RPCs (token-scoped)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_public_quote(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  -- Deliberately excludes internal_notes, ids, created_by and customer contact details.
  SELECT jsonb_build_object(
    'revision_number', q.revision_number,
    'status', q.status,
    'is_superseded', q.superseded_at IS NOT NULL,
    'is_expired', q.expires_at IS NOT NULL AND q.expires_at < current_date,
    'sent_at', q.sent_at,
    'expires_at', q.expires_at,
    'approved_at', q.approved_at,
    'declined_at', q.declined_at,
    -- Parts and line items are rebuilt from an explicit allow-list. Snapshot
    -- objects can carry internal shop fields (part_cost, paint_price, priced,
    -- ship_size, lead_time_days, notes, reference_image_path, ...), and any
    -- key not listed here is never returned.
    'selected_parts', coalesce((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', p.part -> 'id',
        'name', p.part -> 'name',
        'type', p.part -> 'type',
        'price', p.part -> 'price',
        'highlight_color', p.part -> 'highlight_color',
        'paint_style_name', p.part -> 'paint_style_name',
        'selected_options', (
          SELECT jsonb_agg(jsonb_build_object(
            'id', o.opt -> 'id',
            'name', o.opt -> 'name',
            'price', o.opt -> 'price'
          ) ORDER BY o.ord)
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.part -> 'selected_options') = 'array' THEN p.part -> 'selected_options' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS o(opt, ord)
          WHERE jsonb_typeof(o.opt) = 'object'
        ),
        'box', CASE WHEN jsonb_typeof(p.part -> 'box') = 'object' THEN jsonb_build_object(
          'view', p.part -> 'box' -> 'view',
          'x', p.part -> 'box' -> 'x',
          'y', p.part -> 'box' -> 'y',
          'w', p.part -> 'box' -> 'w',
          'h', p.part -> 'box' -> 'h',
          'points', (
            SELECT jsonb_agg(jsonb_build_object('x', pt.v -> 'x', 'y', pt.v -> 'y') ORDER BY pt.ord)
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(p.part -> 'box' -> 'points') = 'array' THEN p.part -> 'box' -> 'points' ELSE '[]'::jsonb END
            ) WITH ORDINALITY AS pt(v, ord)
            WHERE jsonb_typeof(pt.v) = 'object'
          )
        ) END,
        'svg_path', p.part -> 'svg_path',
        'alt_view_svg_path', p.part -> 'alt_view_svg_path',
        'view', p.part -> 'view'
      )) ORDER BY p.ord)
      FROM jsonb_array_elements(q.selected_parts) WITH ORDINALITY AS p(part, ord)
      WHERE jsonb_typeof(p.part) = 'object'
    ), '[]'::jsonb),
    'custom_line_items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', li.item -> 'id',
        'description', li.item -> 'description',
        'quantity', li.item -> 'quantity',
        'unit_price', li.item -> 'unit_price'
      ) ORDER BY li.ord)
      FROM jsonb_array_elements(q.custom_line_items) WITH ORDINALITY AS li(item, ord)
      WHERE jsonb_typeof(li.item) = 'object'
    ), '[]'::jsonb),
    'parts_total', q.parts_total,
    'custom_lines_total', q.custom_lines_total,
    'shipping_total', q.shipping_total,
    'discount_amount', q.discount_amount,
    'tax_rate', q.tax_rate,
    'tax_total', q.tax_total,
    'grand_total', q.grand_total,
    'estimated_lead_time_days', q.estimated_lead_time_days,
    'customer_notes', q.customer_notes,
    'front_image_url', q.front_image_url,
    'rear_image_url', q.rear_image_url,
    'customer_name', l.customer_name,
    'vehicle', jsonb_build_object(
      'name', l.vehicle_name,
      'year', l.vehicle_year,
      'make', l.vehicle_make,
      'model', l.vehicle_model,
      'trim', l.vehicle_trim,
      'paint_code', l.paint_code,
      'fulfillment_mode', l.fulfillment_mode,
      'is_custom', l.is_custom
    ),
    'shop', jsonb_build_object(
      'name', s.name,
      'logo_url', s.logo_url,
      'contact_email', s.contact_email,
      'phone', s.phone
    ),
    'viewer_is_staff', public.quote_viewer_is_staff(q.shop_id)
  )
  INTO v_result
  FROM public.quotes q
  JOIN public.leads l ON l.id = q.lead_id
  JOIN public.shops s ON s.id = q.shop_id
  WHERE q.public_token = p_token
    AND q.status <> 'draft';

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quote_view(p_token uuid, p_view_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_session text := btrim(coalesce(p_view_session_id, ''));
  v_is_new boolean;
BEGIN
  IF p_token IS NULL OR char_length(v_session) NOT BETWEEN 8 AND 128 THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;

  SELECT * INTO v_quote
  FROM public.quotes q
  WHERE q.public_token = p_token AND q.status <> 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;

  IF public.quote_viewer_is_staff(v_quote.shop_id) THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'staff_preview');
  END IF;

  PERFORM set_config('specplus.actor_type', 'customer', true);
  PERFORM set_config('specplus.actor_id', '', true);

  INSERT INTO public.quote_views (quote_id, view_session_id)
  VALUES (v_quote.id, v_session)
  ON CONFLICT (quote_id, view_session_id) DO NOTHING;
  v_is_new := FOUND;

  IF v_is_new THEN
    UPDATE public.quotes
    SET view_count = view_count + 1,
        first_viewed_at = coalesce(first_viewed_at, now()),
        last_viewed_at = now(),
        status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
    WHERE id = v_quote.id;
  ELSE
    UPDATE public.quote_views
    SET last_seen_at = now()
    WHERE quote_id = v_quote.id AND view_session_id = v_session;

    UPDATE public.quotes SET last_viewed_at = now() WHERE id = v_quote.id;
  END IF;

  RETURN jsonb_build_object('recorded', v_is_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_quote(p_token uuid, p_response text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_new_status text;
BEGIN
  IF p_response IS NULL OR p_response NOT IN ('approve', 'decline') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_response');
  END IF;
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT * INTO v_quote
  FROM public.quotes q
  WHERE q.public_token = p_token AND q.status <> 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF public.quote_viewer_is_staff(v_quote.shop_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_preview');
  END IF;
  IF v_quote.status IN ('approved', 'declined') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_responded', 'status', v_quote.status);
  END IF;
  IF v_quote.superseded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'superseded');
  END IF;
  IF v_quote.status NOT IN ('sent', 'viewed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < current_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  PERFORM set_config('specplus.actor_type', 'customer', true);
  PERFORM set_config('specplus.actor_id', '', true);

  v_new_status := CASE p_response WHEN 'approve' THEN 'approved' ELSE 'declined' END;

  UPDATE public.quotes
  SET status = v_new_status,
      approved_at = CASE WHEN v_new_status = 'approved' THEN now() ELSE approved_at END,
      declined_at = CASE WHEN v_new_status = 'declined' THEN now() ELSE declined_at END
  WHERE id = v_quote.id;

  RETURN jsonb_build_object('ok', true, 'status', v_new_status, 'responded_at', now());
END;
$$;

-- ===========================================================================
-- 7. Send path (service_role only; called by the send-quote Edge Function
--    after the email has been accepted by Resend)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.mark_quote_sent(p_quote_id uuid, p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_role text;
  v_actor_shop uuid;
BEGIN
  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_quote.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft quotes can be sent' USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.role, p.shop_id INTO v_role, v_actor_shop FROM public.profiles p WHERE p.id = p_actor_id;
  IF NOT (v_role = 'admin' OR (v_role = 'shop_user' AND v_actor_shop = v_quote.shop_id)) THEN
    RAISE EXCEPTION 'Not allowed to send this quote' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jsonb_array_length(v_quote.selected_parts) = 0 AND jsonb_array_length(v_quote.custom_line_items) = 0 THEN
    RAISE EXCEPTION 'A quote needs at least one item before it can be sent' USING ERRCODE = 'check_violation';
  END IF;
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < current_date THEN
    RAISE EXCEPTION 'The expiration date is in the past' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('specplus.actor_type', v_role, true);
  PERFORM set_config('specplus.actor_id', p_actor_id::text, true);

  UPDATE public.quotes SET status = 'sent', sent_at = now() WHERE id = v_quote.id;

  RETURN (
    SELECT jsonb_build_object('id', q.id, 'status', q.status, 'sent_at', q.sent_at, 'public_token', q.public_token)
    FROM public.quotes q WHERE q.id = v_quote.id
  );
END;
$$;

-- ===========================================================================
-- 8. Backfill: give existing leads a starting point on their timeline
-- ===========================================================================

INSERT INTO public.lead_events (lead_id, shop_id, event_type, actor_type, actor_id, metadata, created_at)
SELECT l.id, l.shop_id, 'lead_created', 'customer', NULL,
       jsonb_build_object('backfilled', true, 'status', l.status),
       l.submitted_at
FROM public.leads l
WHERE NOT EXISTS (
  SELECT 1 FROM public.lead_events e
  WHERE e.lead_id = l.id AND e.event_type = 'lead_created'
);

-- ===========================================================================
-- 9. RLS
-- ===========================================================================

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

-- quotes
DROP POLICY IF EXISTS "quotes_admin_select" ON public.quotes;
CREATE POLICY "quotes_admin_select" ON public.quotes FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');

DROP POLICY IF EXISTS "quotes_admin_insert" ON public.quotes;
CREATE POLICY "quotes_admin_insert" ON public.quotes FOR INSERT
  TO authenticated WITH CHECK (public.get_current_role() = 'admin');

DROP POLICY IF EXISTS "quotes_admin_update" ON public.quotes;
CREATE POLICY "quotes_admin_update" ON public.quotes FOR UPDATE
  TO authenticated
  USING (public.get_current_role() = 'admin' AND status = 'draft')
  WITH CHECK (public.get_current_role() = 'admin');

DROP POLICY IF EXISTS "quotes_shop_select" ON public.quotes;
CREATE POLICY "quotes_shop_select" ON public.quotes FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "quotes_shop_insert" ON public.quotes;
CREATE POLICY "quotes_shop_insert" ON public.quotes FOR INSERT
  TO authenticated WITH CHECK (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "quotes_shop_update" ON public.quotes;
CREATE POLICY "quotes_shop_update" ON public.quotes FOR UPDATE
  TO authenticated
  USING (shop_id = public.get_current_shop_id() AND status = 'draft')
  WITH CHECK (shop_id = public.get_current_shop_id());

-- quote_views
DROP POLICY IF EXISTS "quote_views_admin_select" ON public.quote_views;
CREATE POLICY "quote_views_admin_select" ON public.quote_views FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');

DROP POLICY IF EXISTS "quote_views_shop_select" ON public.quote_views;
CREATE POLICY "quote_views_shop_select" ON public.quote_views FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_views.quote_id
        AND q.shop_id = public.get_current_shop_id()
    )
  );

-- lead_events
DROP POLICY IF EXISTS "lead_events_admin_select" ON public.lead_events;
CREATE POLICY "lead_events_admin_select" ON public.lead_events FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');

DROP POLICY IF EXISTS "lead_events_shop_select" ON public.lead_events;
CREATE POLICY "lead_events_shop_select" ON public.lead_events FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

-- ===========================================================================
-- 10. Grants
-- ===========================================================================

REVOKE ALL PRIVILEGES ON TABLE public.quotes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.quotes TO authenticated;
-- Totals, status, engagement, ownership and revision fields are set by triggers
-- and controlled functions only.
GRANT INSERT (
  lead_id, supersedes_quote_id, selected_parts, custom_line_items, shipping_total,
  discount_amount, tax_rate, estimated_lead_time_days, customer_notes, internal_notes,
  expires_at, front_image_url, rear_image_url
) ON TABLE public.quotes TO authenticated;
GRANT UPDATE (
  selected_parts, custom_line_items, shipping_total, discount_amount, tax_rate,
  estimated_lead_time_days, customer_notes, internal_notes, expires_at
) ON TABLE public.quotes TO authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.quote_views FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.quote_views TO authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.lead_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lead_events TO authenticated;

-- Internal helpers and trigger functions: never callable by clients.
REVOKE ALL ON FUNCTION public.lead_event_actor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_lead_event(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quote_viewer_is_staff(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_before_insert_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_audit_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_audit_status_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quotes_before_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quotes_after_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_events_prevent_update() FROM PUBLIC, anon, authenticated;

-- Public, token-scoped customer operations.
REVOKE ALL ON FUNCTION public.get_public_quote(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_quote_view(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_quote(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_quote(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_quote_view(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_quote(uuid, text) TO anon, authenticated;

-- Server-side send path only.
REVOKE ALL ON FUNCTION public.mark_quote_sent(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_quote_sent(uuid, uuid) TO service_role;

COMMIT;
