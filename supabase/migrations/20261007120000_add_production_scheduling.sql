/*
# Production scheduling (date-only)

Builds on 20261003200000_lead_lifecycle_phase_1.sql and
20261003230000_add_quote_conversation.sql (already applied; not edited).

Flow (custom and preconfigured leads alike):
  1. Customer approves the current quote.
  2. Staff create date options for that approved revision
     (create_schedule_offer -> draft), and the send-schedule-options Edge
     Function emails the existing quote review link, then activates them
     (mark_schedule_offer_sent, service_role only). Activating supersedes any
     previously active options and their pending request.
  3. The customer picks one active option on the quote page
     (request_schedule_date, token-scoped). Nothing is reserved.
  4. Staff confirm (confirm_schedule): one transaction that rechecks the
     pending request, the current approved quote, ownership, write access and
     the per-lead concurrency version, then creates the reservation, sets the
     lead to `scheduled` and records the audit event.
  Rescheduling repeats 2-4 while the current reservation stays active until
  its replacement is confirmed. cancel_schedule cancels explicitly.

Rules enforced here:
  - A NEW transition to `scheduled` requires an active reservation; a lead
    with an active reservation can only move forward (in_progress/completed)
    until the reservation is cancelled. Existing undated `scheduled` leads are
    left as they are (no backfill).
  - A new quote revision invalidates outstanding (draft/active) options and
    pending requests. It never touches a confirmed reservation, which keeps
    its linked approved quote.
  - Read-only (billing) shop users cannot change schedules.

Security: tables are SELECT-only for authenticated users (RLS by shop / admin)
and closed to anon. All writes go through the functions below, which check
the caller's role and shop explicitly. Audit events use the existing
record_lead_event helper from definer code only; helpers stay revoked.
*/

BEGIN;

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

-- Per-lead optimistic concurrency version for scheduling state. Every
-- scheduling change bumps it; staff actions must present the version they
-- loaded.
CREATE TABLE IF NOT EXISTS public.lead_schedule_states (
  lead_id uuid PRIMARY KEY REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.schedule_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  quote_revision_number integer NOT NULL CHECK (quote_revision_number >= 1),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'invalidated', 'withdrawn', 'closed')),
  customer_note text CHECK (customer_note IS NULL OR (customer_note = btrim(customer_note) AND char_length(customer_note) BETWEEN 1 AND 1000)),
  is_reschedule boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  sent_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT schedule_offers_sent_has_time CHECK (status IN ('draft', 'withdrawn', 'invalidated') OR sent_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_schedule_offers_lead ON public.schedule_offers(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_offers_shop ON public.schedule_offers(shop_id);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_offers_one_draft_per_lead
  ON public.schedule_offers(lead_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS schedule_offers_one_active_per_lead
  ON public.schedule_offers(lead_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.schedule_offer_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES public.schedule_offers(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  CONSTRAINT schedule_offer_options_unique_date UNIQUE (offer_id, start_date)
);

CREATE INDEX IF NOT EXISTS idx_schedule_offer_options_lead ON public.schedule_offer_options(lead_id);

CREATE TABLE IF NOT EXISTS public.schedule_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES public.schedule_offers(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES public.schedule_offer_options(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'replaced', 'superseded', 'invalidated', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT schedule_requests_resolved_time CHECK ((status = 'pending') = (resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_schedule_requests_lead ON public.schedule_requests(lead_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_requests_shop_date ON public.schedule_requests(shop_id, start_date) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS schedule_requests_one_pending_per_lead
  ON public.schedule_requests(lead_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.schedule_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  -- The approved quote revision this booking was confirmed against.
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  quote_revision_number integer NOT NULL CHECK (quote_revision_number >= 1),
  request_id uuid REFERENCES public.schedule_requests(id) ON DELETE SET NULL,
  start_date date NOT NULL,
  estimated_ready_date date NOT NULL,
  internal_notes text CHECK (internal_notes IS NULL OR (internal_notes = btrim(internal_notes) AND char_length(internal_notes) BETWEEN 1 AND 2000)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'cancelled')),
  confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ended_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR (cancel_reason = btrim(cancel_reason) AND char_length(cancel_reason) BETWEEN 1 AND 1000)),
  replaced_by_id uuid REFERENCES public.schedule_reservations(id) ON DELETE SET NULL,
  CONSTRAINT schedule_reservations_date_order CHECK (estimated_ready_date >= start_date),
  CONSTRAINT schedule_reservations_end_time CHECK ((status = 'active') = (ended_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_schedule_reservations_lead ON public.schedule_reservations(lead_id, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_reservations_shop_dates
  ON public.schedule_reservations(shop_id, start_date, estimated_ready_date) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS schedule_reservations_one_active_per_lead
  ON public.schedule_reservations(lead_id) WHERE status = 'active';

-- ===========================================================================
-- 2. History protection (writes only come from the functions below; these
--    guards keep the history append-only even for definer code)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.schedule_history_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Referential actions (cascades from deleting a lead/shop, SET NULL when a
  -- profile is deleted) and this migration's own trigger arrive nested.
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Scheduling history cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'schedule_offer_options' THEN
    RAISE EXCEPTION 'Offered dates cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'schedule_offers' THEN
    IF (NEW.id, NEW.lead_id, NEW.shop_id, NEW.quote_id, NEW.quote_revision_number, NEW.customer_note,
        NEW.is_reschedule, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.lead_id, OLD.shop_id, OLD.quote_id, OLD.quote_revision_number, OLD.customer_note,
        OLD.is_reschedule, OLD.created_by, OLD.created_at)
      OR NOT (
        NEW.status = OLD.status
        OR (OLD.status = 'draft' AND NEW.status IN ('active', 'withdrawn', 'invalidated'))
        OR (OLD.status = 'active' AND NEW.status IN ('superseded', 'invalidated', 'withdrawn', 'closed'))
      )
    THEN
      RAISE EXCEPTION 'Invalid change to date options' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'schedule_requests' THEN
    IF (NEW.id, NEW.lead_id, NEW.shop_id, NEW.offer_id, NEW.option_id, NEW.quote_id, NEW.start_date, NEW.requested_at)
       IS DISTINCT FROM
       (OLD.id, OLD.lead_id, OLD.shop_id, OLD.offer_id, OLD.option_id, OLD.quote_id, OLD.start_date, OLD.requested_at)
      OR (OLD.status <> 'pending' AND (NEW.status, NEW.resolved_at, NEW.resolved_by) IS DISTINCT FROM (OLD.status, OLD.resolved_at, OLD.resolved_by))
    THEN
      RAISE EXCEPTION 'Invalid change to a date request' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'schedule_reservations' THEN
    IF (NEW.id, NEW.lead_id, NEW.shop_id, NEW.quote_id, NEW.quote_revision_number, NEW.request_id, NEW.start_date,
        NEW.estimated_ready_date, NEW.internal_notes, NEW.confirmed_by, NEW.confirmed_at)
       IS DISTINCT FROM
       (OLD.id, OLD.lead_id, OLD.shop_id, OLD.quote_id, OLD.quote_revision_number, OLD.request_id, OLD.start_date,
        OLD.estimated_ready_date, OLD.internal_notes, OLD.confirmed_by, OLD.confirmed_at)
      OR (OLD.status <> 'active' AND (NEW.status, NEW.ended_at, NEW.ended_by, NEW.cancel_reason)
          IS DISTINCT FROM (OLD.status, OLD.ended_at, OLD.ended_by, OLD.cancel_reason))
      OR (OLD.replaced_by_id IS NOT NULL AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id)
    THEN
      RAISE EXCEPTION 'Confirmed schedules cannot be rewritten' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schedule_offers_history_guard ON public.schedule_offers;
CREATE TRIGGER schedule_offers_history_guard
  BEFORE UPDATE OR DELETE ON public.schedule_offers
  FOR EACH ROW EXECUTE FUNCTION public.schedule_history_guard();
DROP TRIGGER IF EXISTS schedule_offer_options_history_guard ON public.schedule_offer_options;
CREATE TRIGGER schedule_offer_options_history_guard
  BEFORE UPDATE OR DELETE ON public.schedule_offer_options
  FOR EACH ROW EXECUTE FUNCTION public.schedule_history_guard();
DROP TRIGGER IF EXISTS schedule_requests_history_guard ON public.schedule_requests;
CREATE TRIGGER schedule_requests_history_guard
  BEFORE UPDATE OR DELETE ON public.schedule_requests
  FOR EACH ROW EXECUTE FUNCTION public.schedule_history_guard();
DROP TRIGGER IF EXISTS schedule_reservations_history_guard ON public.schedule_reservations;
CREATE TRIGGER schedule_reservations_history_guard
  BEFORE UPDATE OR DELETE ON public.schedule_reservations
  FOR EACH ROW EXECUTE FUNCTION public.schedule_history_guard();

-- ===========================================================================
-- 3. Internal helpers (not executable by clients)
-- ===========================================================================

-- Mirrors the app's billing rule (src/lib/billing.tsx computeBilling).
CREATE OR REPLACE FUNCTION public.schedule_shop_is_read_only(p_shop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NOT coalesce((
    SELECT s.is_lifetime_free
      OR s.subscription_status = 'active'
      OR (s.subscription_status IN ('trial', 'trialing') AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at >= now())
    FROM public.shops s WHERE s.id = p_shop_id
  ), false);
$$;

-- Authorizes an admin or a writable shop user of the given shop.
CREATE OR REPLACE FUNCTION public.schedule_authorize(p_actor_id uuid, p_shop_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_shop uuid;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.role, p.shop_id INTO v_role, v_shop FROM public.profiles p WHERE p.id = p_actor_id;
  IF v_role = 'admin' THEN
    RETURN v_role;
  END IF;
  IF v_role IS DISTINCT FROM 'shop_user' OR v_shop IS DISTINCT FROM p_shop_id THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF public.schedule_shop_is_read_only(p_shop_id) THEN
    RAISE EXCEPTION 'Your account is read-only. Reactivate your subscription to change schedules.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END;
$$;

-- The lead's latest quote revision; scheduling needs it to be approved and
-- not superseded.
CREATE OR REPLACE FUNCTION public.schedule_current_quote(p_lead_id uuid)
RETURNS public.quotes
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT q.* FROM public.quotes q
  WHERE q.lead_id = p_lead_id
  ORDER BY q.revision_number DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.schedule_version_of(p_lead_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.version FROM public.lead_schedule_states s WHERE s.lead_id = p_lead_id), 0);
$$;

CREATE OR REPLACE FUNCTION public.schedule_bump_version(p_lead_id uuid, p_shop_id uuid)
RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO public.lead_schedule_states AS s (lead_id, shop_id, version, updated_at)
  VALUES (p_lead_id, p_shop_id, 1, now())
  ON CONFLICT (lead_id) DO UPDATE SET version = s.version + 1, updated_at = now()
  RETURNING version;
$$;

CREATE OR REPLACE FUNCTION public.schedule_check_version(p_lead_id uuid, p_expected integer)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_expected IS DISTINCT FROM public.schedule_version_of(p_lead_id) THEN
    RAISE EXCEPTION 'This schedule changed since you loaded it. Reload the lead and try again.'
      USING ERRCODE = 'serialization_failure';
  END IF;
END;
$$;

-- A start date stays eligible until it has passed, with one day of tolerance
-- for shops west of UTC. Offering, sending, requesting and confirming all use
-- this same rule.
CREATE OR REPLACE FUNCTION public.schedule_start_date_is_open(p_start date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_start IS NOT NULL AND p_start >= current_date - 1;
$$;

-- ===========================================================================
-- 4. Lead status guard
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.leads_schedule_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booked boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'scheduled' THEN
      RAISE EXCEPTION 'A new lead cannot start as Scheduled' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_booked := EXISTS (
    SELECT 1 FROM public.schedule_reservations r WHERE r.lead_id = NEW.id AND r.status = 'active'
  );
  IF NEW.status = 'scheduled' AND NOT v_booked THEN
    RAISE EXCEPTION 'Scheduled requires a confirmed production date. Offer dates and confirm the customer''s choice.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_booked AND NEW.status NOT IN ('scheduled', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'This job has a confirmed schedule. Cancel the schedule before moving it to an earlier stage.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_schedule_status_guard ON public.leads;
CREATE TRIGGER leads_schedule_status_guard
  BEFORE INSERT OR UPDATE OF status ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_schedule_status_guard();

-- ===========================================================================
-- 5. Quote revisions invalidate outstanding options (never bookings)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.quotes_invalidate_schedule_offers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_offers integer;
  v_requests integer;
BEGIN
  UPDATE public.schedule_requests
  SET status = 'invalidated', resolved_at = now()
  WHERE lead_id = NEW.lead_id AND status = 'pending';
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  UPDATE public.schedule_offers
  SET status = 'invalidated', closed_at = now()
  WHERE lead_id = NEW.lead_id AND status IN ('draft', 'active');
  GET DIAGNOSTICS v_offers = ROW_COUNT;

  IF v_offers > 0 OR v_requests > 0 THEN
    PERFORM public.schedule_bump_version(NEW.lead_id, NEW.shop_id);
    PERFORM public.record_lead_event(NEW.lead_id, NEW.id, 'schedule_options_invalidated',
      jsonb_build_object('revision_number', NEW.revision_number, 'offers', v_offers, 'requests', v_requests));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS quotes_invalidate_schedule_offers ON public.quotes;
CREATE TRIGGER quotes_invalidate_schedule_offers
  AFTER INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_invalidate_schedule_offers();

-- ===========================================================================
-- 6. Staff functions
-- ===========================================================================

-- Creates (or replaces) the lead's unsent draft options for its current
-- approved quote. Customers never see drafts.
CREATE OR REPLACE FUNCTION public.create_schedule_offer(
  p_lead_id uuid,
  p_expected_version integer,
  p_start_dates date[],
  p_customer_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lead public.leads%ROWTYPE;
  v_quote public.quotes%ROWTYPE;
  v_dates date[];
  v_note text := nullif(btrim(coalesce(p_customer_note, '')), '');
  v_offer_id uuid;
BEGIN
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.schedule_authorize(v_uid, v_lead.shop_id);
  PERFORM public.schedule_check_version(v_lead.id, p_expected_version);

  IF v_lead.status IN ('in_progress', 'completed') THEN
    RAISE EXCEPTION 'Work has started, so this job cannot be rescheduled here.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_lead.status IN ('lost', 'archived') THEN
    RAISE EXCEPTION 'Reopen this lead before offering dates.' USING ERRCODE = 'check_violation';
  END IF;

  v_quote := public.schedule_current_quote(v_lead.id);
  IF v_quote.id IS NULL OR v_quote.status <> 'approved' OR v_quote.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'The customer must approve the current quote before dates can be offered.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(DISTINCT d ORDER BY d) INTO v_dates FROM unnest(coalesce(p_start_dates, '{}'::date[])) d WHERE d IS NOT NULL;
  IF v_dates IS NULL OR array_length(v_dates, 1) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Offer between 1 and 10 start dates.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.schedule_start_date_is_open(v_dates[1]) THEN
    RAISE EXCEPTION 'Start dates cannot be in the past.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'The note must be 1000 characters or fewer.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.schedule_offers SET status = 'withdrawn', closed_at = now()
  WHERE lead_id = v_lead.id AND status = 'draft';

  INSERT INTO public.schedule_offers (lead_id, shop_id, quote_id, quote_revision_number, status, customer_note, is_reschedule, created_by)
  VALUES (v_lead.id, v_lead.shop_id, v_quote.id, v_quote.revision_number, 'draft', v_note,
    EXISTS (SELECT 1 FROM public.schedule_reservations r WHERE r.lead_id = v_lead.id AND r.status = 'active'), v_uid)
  RETURNING id INTO v_offer_id;

  INSERT INTO public.schedule_offer_options (offer_id, lead_id, shop_id, start_date)
  SELECT v_offer_id, v_lead.id, v_lead.shop_id, d FROM unnest(v_dates) d;

  RETURN jsonb_build_object('ok', true, 'offer_id', v_offer_id,
    'version', public.schedule_bump_version(v_lead.id, v_lead.shop_id));
END;
$$;

-- Called by the send-schedule-options Edge Function (service_role) only after
-- the email was accepted. Activates the draft and supersedes older options.
CREATE OR REPLACE FUNCTION public.mark_schedule_offer_sent(p_offer_id uuid, p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_offer public.schedule_offers%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_quote public.quotes%ROWTYPE;
  v_role text;
  v_dates jsonb;
BEGIN
  SELECT * INTO v_offer FROM public.schedule_offers o WHERE o.id = p_offer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Date options not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_offer.lead_id FOR UPDATE;
  SELECT * INTO v_offer FROM public.schedule_offers o WHERE o.id = p_offer_id FOR UPDATE;
  v_role := public.schedule_authorize(p_actor_id, v_offer.shop_id);

  IF v_offer.status <> 'draft' THEN
    RAISE EXCEPTION 'These date options were already sent or replaced.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_lead.status IN ('in_progress', 'completed', 'lost', 'archived') THEN
    RAISE EXCEPTION 'Dates can no longer be offered for this job.' USING ERRCODE = 'check_violation';
  END IF;
  v_quote := public.schedule_current_quote(v_lead.id);
  IF v_quote.id IS DISTINCT FROM v_offer.quote_id OR v_quote.status <> 'approved' OR v_quote.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'The quote changed. Offer new dates for the current approved quote.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.schedule_offer_options o
    WHERE o.offer_id = v_offer.id AND NOT public.schedule_start_date_is_open(o.start_date)
  ) THEN
    RAISE EXCEPTION 'One or more of these dates have passed. Offer fresh dates.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('specplus.actor_type', v_role, true);
  PERFORM set_config('specplus.actor_id', p_actor_id::text, true);

  UPDATE public.schedule_requests SET status = 'superseded', resolved_at = now()
  WHERE lead_id = v_lead.id AND status = 'pending';
  UPDATE public.schedule_offers SET status = 'superseded', closed_at = now()
  WHERE lead_id = v_lead.id AND status = 'active';
  UPDATE public.schedule_offers SET status = 'active', sent_at = now(), sent_by = p_actor_id
  WHERE id = v_offer.id;

  SELECT jsonb_agg(o.start_date ORDER BY o.start_date) INTO v_dates
  FROM public.schedule_offer_options o WHERE o.offer_id = v_offer.id;

  PERFORM public.record_lead_event(v_lead.id, v_quote.id, 'schedule_options_sent',
    jsonb_build_object('offer_id', v_offer.id, 'start_dates', v_dates,
      'reschedule', v_offer.is_reschedule, 'revision_number', v_quote.revision_number));

  RETURN jsonb_build_object('ok', true, 'offer_id', v_offer.id, 'public_token', v_quote.public_token,
    'version', public.schedule_bump_version(v_lead.id, v_lead.shop_id));
END;
$$;

-- The only path that books a date. All checks and writes are one transaction;
-- any failure raises and leaves nothing behind.
CREATE OR REPLACE FUNCTION public.confirm_schedule(
  p_request_id uuid,
  p_expected_version integer,
  p_estimated_ready_date date,
  p_internal_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_request public.schedule_requests%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_offer public.schedule_offers%ROWTYPE;
  v_quote public.quotes%ROWTYPE;
  v_previous public.schedule_reservations%ROWTYPE;
  v_notes text := nullif(btrim(coalesce(p_internal_notes, '')), '');
  v_reservation_id uuid;
BEGIN
  SELECT * INTO v_request FROM public.schedule_requests r WHERE r.id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Date request not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_request.lead_id FOR UPDATE;
  PERFORM public.schedule_authorize(v_uid, v_lead.shop_id);
  PERFORM public.schedule_check_version(v_lead.id, p_expected_version);

  SELECT * INTO v_request FROM public.schedule_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This date request is no longer pending.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_offer FROM public.schedule_offers o WHERE o.id = v_request.offer_id FOR UPDATE;
  IF v_offer.status <> 'active' THEN
    RAISE EXCEPTION 'The date options for this request were replaced.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.schedule_start_date_is_open(v_request.start_date) THEN
    RAISE EXCEPTION 'The requested start date has passed. Offer fresh dates.' USING ERRCODE = 'check_violation';
  END IF;
  v_quote := public.schedule_current_quote(v_lead.id);
  IF v_quote.id IS DISTINCT FROM v_request.quote_id OR v_quote.id IS DISTINCT FROM v_offer.quote_id
     OR v_quote.status <> 'approved' OR v_quote.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'The quote changed after these dates were offered. The customer must approve the current quote first.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_lead.status IN ('in_progress', 'completed', 'lost', 'archived') THEN
    RAISE EXCEPTION 'This job can no longer be scheduled here.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_estimated_ready_date IS NULL OR p_estimated_ready_date < v_request.start_date THEN
    RAISE EXCEPTION 'The estimated-ready date must be on or after the start date.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'Internal notes must be 2000 characters or fewer.' USING ERRCODE = 'check_violation';
  END IF;

  -- Rescheduling: the current booking stays active until right here.
  SELECT * INTO v_previous FROM public.schedule_reservations r
  WHERE r.lead_id = v_lead.id AND r.status = 'active' FOR UPDATE;
  IF FOUND THEN
    UPDATE public.schedule_reservations SET status = 'replaced', ended_at = now(), ended_by = v_uid
    WHERE id = v_previous.id;
  END IF;

  INSERT INTO public.schedule_reservations (lead_id, shop_id, quote_id, quote_revision_number, request_id,
    start_date, estimated_ready_date, internal_notes, confirmed_by)
  VALUES (v_lead.id, v_lead.shop_id, v_quote.id, v_quote.revision_number, v_request.id,
    v_request.start_date, p_estimated_ready_date, v_notes, v_uid)
  RETURNING id INTO v_reservation_id;

  IF v_previous.id IS NOT NULL THEN
    UPDATE public.schedule_reservations SET replaced_by_id = v_reservation_id WHERE id = v_previous.id;
  END IF;

  UPDATE public.schedule_requests SET status = 'confirmed', resolved_at = now(), resolved_by = v_uid
  WHERE id = v_request.id;
  UPDATE public.schedule_offers SET status = 'closed', closed_at = now() WHERE id = v_offer.id;
  IF v_lead.status <> 'scheduled' THEN
    UPDATE public.leads SET status = 'scheduled' WHERE id = v_lead.id;
  END IF;

  PERFORM public.record_lead_event(v_lead.id, v_quote.id, 'schedule_confirmed',
    jsonb_build_object(
      'reservation_id', v_reservation_id,
      'start_date', v_request.start_date,
      'estimated_ready_date', p_estimated_ready_date,
      'rescheduled', v_previous.id IS NOT NULL,
      'previous_start_date', v_previous.start_date,
      'previous_estimated_ready_date', v_previous.estimated_ready_date,
      'revision_number', v_quote.revision_number
    ));

  RETURN jsonb_build_object('ok', true, 'reservation_id', v_reservation_id,
    'version', public.schedule_bump_version(v_lead.id, v_lead.shop_id));
END;
$$;

-- Explicit cancellation. Allowed even while newer quote terms await approval;
-- not once work has started.
CREATE OR REPLACE FUNCTION public.cancel_schedule(p_lead_id uuid, p_expected_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lead public.leads%ROWTYPE;
  v_reservation public.schedule_reservations%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.schedule_authorize(v_uid, v_lead.shop_id);
  PERFORM public.schedule_check_version(v_lead.id, p_expected_version);

  IF v_lead.status IN ('in_progress', 'completed') THEN
    RAISE EXCEPTION 'Work has started, so this schedule cannot be cancelled here.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_reservation FROM public.schedule_reservations r
  WHERE r.lead_id = v_lead.id AND r.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no confirmed schedule to cancel.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'The reason must be 1000 characters or fewer.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.schedule_reservations
  SET status = 'cancelled', ended_at = now(), ended_by = v_uid, cancel_reason = v_reason
  WHERE id = v_reservation.id;
  UPDATE public.schedule_requests SET status = 'cancelled', resolved_at = now(), resolved_by = v_uid
  WHERE lead_id = v_lead.id AND status = 'pending';
  UPDATE public.schedule_offers SET status = 'withdrawn', closed_at = now()
  WHERE lead_id = v_lead.id AND status IN ('draft', 'active');
  UPDATE public.leads SET status = 'scheduling' WHERE id = v_lead.id AND status <> 'scheduling';

  PERFORM public.record_lead_event(v_lead.id, v_reservation.quote_id, 'schedule_cancelled',
    jsonb_build_object('reservation_id', v_reservation.id, 'start_date', v_reservation.start_date,
      'estimated_ready_date', v_reservation.estimated_ready_date));

  RETURN jsonb_build_object('ok', true, 'version', public.schedule_bump_version(v_lead.id, v_lead.shop_id));
END;
$$;

-- ===========================================================================
-- 7. Customer functions (token-scoped, like the quote review RPCs)
-- ===========================================================================

-- Customer-safe scheduling state for one quote link. Only this project's
-- active options, its own pending request and its own booking dates; never
-- internal notes, other jobs, or ids beyond the option ids to choose from.
CREATE OR REPLACE FUNCTION public.get_public_schedule(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_current public.quotes%ROWTYPE;
  v_offer public.schedule_offers%ROWTYPE;
  v_is_current boolean;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_quote FROM public.quotes q WHERE q.public_token = p_token AND q.status <> 'draft';
  IF NOT FOUND OR v_quote.superseded_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  v_current := public.schedule_current_quote(v_quote.lead_id);
  v_is_current := v_current.id = v_quote.id AND v_quote.status = 'approved';

  IF v_is_current THEN
    SELECT * INTO v_offer FROM public.schedule_offers o
    WHERE o.lead_id = v_quote.lead_id AND o.status = 'active' AND o.quote_id = v_quote.id;
  END IF;

  RETURN jsonb_build_object(
    'can_request', v_offer.id IS NOT NULL,
    'offer', CASE WHEN v_offer.id IS NULL THEN NULL ELSE jsonb_build_object(
      'note', v_offer.customer_note,
      'is_reschedule', v_offer.is_reschedule,
      'options', (SELECT jsonb_agg(jsonb_build_object('id', o.id, 'start_date', o.start_date) ORDER BY o.start_date)
                  FROM public.schedule_offer_options o WHERE o.offer_id = v_offer.id)
    ) END,
    'request', (SELECT jsonb_build_object('option_id', r.option_id, 'start_date', r.start_date, 'requested_at', r.requested_at)
                FROM public.schedule_requests r
                WHERE r.lead_id = v_quote.lead_id AND r.status = 'pending' AND r.offer_id = v_offer.id),
    'booking', (SELECT jsonb_build_object('start_date', r.start_date, 'estimated_ready_date', r.estimated_ready_date)
                FROM public.schedule_reservations r
                WHERE r.lead_id = v_quote.lead_id AND r.status = 'active')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_schedule_date(p_token uuid, p_option_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_current public.quotes%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_option public.schedule_offer_options%ROWTYPE;
  v_offer public.schedule_offers%ROWTYPE;
  v_pending public.schedule_requests%ROWTYPE;
  v_request_id uuid;
BEGIN
  IF p_token IS NULL OR p_option_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  SELECT * INTO v_quote FROM public.quotes q WHERE q.public_token = p_token AND q.status <> 'draft';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF public.quote_viewer_is_staff(v_quote.shop_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_preview');
  END IF;

  -- Serializes with staff scheduling actions and quote revisions.
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_quote.lead_id FOR UPDATE;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = v_quote.id;
  v_current := public.schedule_current_quote(v_lead.id);
  IF v_quote.superseded_at IS NOT NULL OR v_current.id IS DISTINCT FROM v_quote.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'superseded');
  END IF;
  IF v_quote.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quote_not_approved');
  END IF;

  SELECT * INTO v_option FROM public.schedule_offer_options o WHERE o.id = p_option_id AND o.lead_id = v_lead.id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
  END IF;
  SELECT * INTO v_offer FROM public.schedule_offers o WHERE o.id = v_option.offer_id;
  IF v_offer.status <> 'active' OR v_offer.quote_id <> v_quote.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'options_replaced');
  END IF;
  IF v_lead.status IN ('in_progress', 'completed', 'lost', 'archived') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_available');
  END IF;
  IF NOT public.schedule_start_date_is_open(v_option.start_date) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'date_passed');
  END IF;

  SELECT * INTO v_pending FROM public.schedule_requests r WHERE r.lead_id = v_lead.id AND r.status = 'pending';
  IF FOUND AND v_pending.option_id = v_option.id THEN
    -- Repeated submission of the same choice is a no-op.
    RETURN jsonb_build_object('ok', true, 'start_date', v_pending.start_date, 'already_requested', true);
  END IF;

  IF (SELECT count(*) FROM public.schedule_requests r
      WHERE r.lead_id = v_lead.id AND r.requested_at > now() - interval '10 minutes') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  PERFORM set_config('specplus.actor_type', 'customer', true);
  PERFORM set_config('specplus.actor_id', '', true);

  IF v_pending.id IS NOT NULL THEN
    UPDATE public.schedule_requests SET status = 'replaced', resolved_at = now() WHERE id = v_pending.id;
  END IF;
  INSERT INTO public.schedule_requests (lead_id, shop_id, offer_id, option_id, quote_id, start_date)
  VALUES (v_lead.id, v_lead.shop_id, v_offer.id, v_option.id, v_quote.id, v_option.start_date)
  RETURNING id INTO v_request_id;

  -- The project stays in the Scheduling stage until staff confirm.
  IF v_lead.status = 'approved' THEN
    UPDATE public.leads SET status = 'scheduling' WHERE id = v_lead.id;
  END IF;

  PERFORM public.schedule_bump_version(v_lead.id, v_lead.shop_id);
  PERFORM public.record_lead_event(v_lead.id, v_quote.id, 'schedule_date_requested',
    jsonb_build_object('request_id', v_request_id, 'start_date', v_option.start_date,
      'reschedule', v_offer.is_reschedule, 'changed_choice', v_pending.id IS NOT NULL));

  RETURN jsonb_build_object('ok', true, 'start_date', v_option.start_date, 'already_requested', false);
END;
$$;

-- ===========================================================================
-- 8. RLS (read-only for staff; nothing for anon)
-- ===========================================================================

ALTER TABLE public.lead_schedule_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_offer_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_schedule_states_admin_select" ON public.lead_schedule_states;
CREATE POLICY "lead_schedule_states_admin_select" ON public.lead_schedule_states FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "lead_schedule_states_shop_select" ON public.lead_schedule_states;
CREATE POLICY "lead_schedule_states_shop_select" ON public.lead_schedule_states FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "schedule_offers_admin_select" ON public.schedule_offers;
CREATE POLICY "schedule_offers_admin_select" ON public.schedule_offers FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "schedule_offers_shop_select" ON public.schedule_offers;
CREATE POLICY "schedule_offers_shop_select" ON public.schedule_offers FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "schedule_offer_options_admin_select" ON public.schedule_offer_options;
CREATE POLICY "schedule_offer_options_admin_select" ON public.schedule_offer_options FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "schedule_offer_options_shop_select" ON public.schedule_offer_options;
CREATE POLICY "schedule_offer_options_shop_select" ON public.schedule_offer_options FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "schedule_requests_admin_select" ON public.schedule_requests;
CREATE POLICY "schedule_requests_admin_select" ON public.schedule_requests FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "schedule_requests_shop_select" ON public.schedule_requests;
CREATE POLICY "schedule_requests_shop_select" ON public.schedule_requests FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "schedule_reservations_admin_select" ON public.schedule_reservations;
CREATE POLICY "schedule_reservations_admin_select" ON public.schedule_reservations FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "schedule_reservations_shop_select" ON public.schedule_reservations;
CREATE POLICY "schedule_reservations_shop_select" ON public.schedule_reservations FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

REVOKE ALL PRIVILEGES ON TABLE public.lead_schedule_states FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.schedule_offers FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.schedule_offer_options FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.schedule_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.schedule_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lead_schedule_states TO authenticated;
GRANT SELECT ON TABLE public.schedule_offers TO authenticated;
GRANT SELECT ON TABLE public.schedule_offer_options TO authenticated;
GRANT SELECT ON TABLE public.schedule_requests TO authenticated;
GRANT SELECT ON TABLE public.schedule_reservations TO authenticated;

-- Internal helpers and triggers: never callable by clients.
REVOKE ALL ON FUNCTION public.schedule_history_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_shop_is_read_only(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_authorize(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_current_quote(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_version_of(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_bump_version(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_check_version(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_start_date_is_open(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_schedule_status_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quotes_invalidate_schedule_offers() FROM PUBLIC, anon, authenticated;

-- Staff (authorization is checked inside each function).
REVOKE ALL ON FUNCTION public.create_schedule_offer(uuid, integer, date[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_schedule(uuid, integer, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_schedule(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_schedule_offer(uuid, integer, date[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_schedule(uuid, integer, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_schedule(uuid, integer, text) TO authenticated;

-- Server-side send path only.
REVOKE ALL ON FUNCTION public.mark_schedule_offer_sent(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_schedule_offer_sent(uuid, uuid) TO service_role;

-- Customer, token-scoped.
REVOKE ALL ON FUNCTION public.get_public_schedule(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_schedule_date(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_schedule(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_schedule_date(uuid, uuid) TO anon, authenticated;

COMMIT;
