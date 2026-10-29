/*
# Customer calendar scheduling

Builds on 20261007120000_add_production_scheduling.sql (already applied; not
edited). After approving the current quote, a customer can request a start
date from a calendar without the shop offering individual dates first.

Shop availability (Schedule page):
  - shop_schedule_settings.booking_window_days: rolling window customers may
    book within (default 60 days, 7 to 365). Shops without a row use the
    default, so nobody is blocked from scheduling by this migration.
  - shop_blocked_dates: one row per blocked date. Blocking/unblocking a range
    adds/removes each date, so a single day inside a blocked range can be
    reopened. Existing jobs never block a date; the shop decides when it is
    full.
  Both are read-only tables for the shop's own staff (and admins). All writes
  go through set_schedule_booking_window / set_schedule_dates_blocked, which
  use the same authorization as scheduling (admin, or a writable shop_user of
  that shop; read-only billing shops are refused).

Customer calendar request (request_schedule_calendar_date, token-scoped):
  - Allowed only for the current approved quote, when the job is not booked,
    work has not started, the lead is open, and no date options are active
    (customers who already received options keep using them).
  - The date must be within [tomorrow, today + window] (server UTC date) and
    not blocked. Checked under the lead lock and the shop's availability lock
    (see below).
  - Creates a pending schedule_requests row with source = 'calendar' (no
    offer/option) and records the same schedule_date_requested event, so the
    existing date_requested notification and the Scheduling stage apply.

Confirmation (confirm_schedule, replaced) accepts calendar requests and, for
every request, refuses a start date the shop has since blocked. The booking
window limits customers only; staff may confirm beyond it.

Offered dates (transition): get_public_schedule marks blocked options
unavailable, request_schedule_date refuses them, and create_schedule_offer
refuses blocked dates. Bookings, history and rescheduling are unchanged.

Customer-safe output: get_public_schedule exposes the window bounds and the
shop's blocked dates inside it, never other jobs, requests, names or notes.

Availability lock: a transaction-scoped advisory lock per shop
(schedule_lock_availability), so it exists whether or not the shop has a
settings row. Changing availability (window, block/unblock) takes it
exclusively; every write that checks availability (customer requests,
confirm_schedule, create_schedule_offer) takes it shared before its check
and holds it until commit, so a block can't land between a check and the
write it guards. Lock order is always lead row first, then the availability
lock; the availability changes take no lead locks, so the two can't
deadlock. Authorization still runs before any lock.
*/

BEGIN;

-- ===========================================================================
-- 1. Availability tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.shop_schedule_settings (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  booking_window_days integer NOT NULL DEFAULT 60 CHECK (booking_window_days BETWEEN 7 AND 365),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shop_blocked_dates (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  blocked_date date NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, blocked_date)
);

-- ===========================================================================
-- 2. Calendar requests (no offer/option)
-- ===========================================================================

ALTER TABLE public.schedule_requests
  ALTER COLUMN offer_id DROP NOT NULL,
  ALTER COLUMN option_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'offer' CHECK (source IN ('offer', 'calendar'));

ALTER TABLE public.schedule_requests DROP CONSTRAINT IF EXISTS schedule_requests_source_shape;
ALTER TABLE public.schedule_requests ADD CONSTRAINT schedule_requests_source_shape CHECK (
  (source = 'offer' AND offer_id IS NOT NULL AND option_id IS NOT NULL)
  OR (source = 'calendar' AND offer_id IS NULL AND option_id IS NULL)
);

-- Same guard as before, with the request's source kept immutable too.
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
    IF (NEW.id, NEW.lead_id, NEW.shop_id, NEW.offer_id, NEW.option_id, NEW.quote_id, NEW.start_date, NEW.requested_at, NEW.source)
       IS DISTINCT FROM
       (OLD.id, OLD.lead_id, OLD.shop_id, OLD.offer_id, OLD.option_id, OLD.quote_id, OLD.start_date, OLD.requested_at, OLD.source)
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

-- ===========================================================================
-- 3. Internal helpers (not executable by clients)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.schedule_booking_window_days(p_shop_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.booking_window_days FROM public.shop_schedule_settings s WHERE s.shop_id = p_shop_id), 60);
$$;

CREATE OR REPLACE FUNCTION public.schedule_date_is_blocked(p_shop_id uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.shop_blocked_dates b WHERE b.shop_id = p_shop_id AND b.blocked_date = p_date);
$$;

-- Why a customer can't request this calendar date, or NULL when they can.
-- The window runs from tomorrow through today + the shop's window (UTC dates).
CREATE OR REPLACE FUNCTION public.schedule_calendar_date_problem(p_shop_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_date IS NULL THEN 'invalid_date'
    WHEN p_date < current_date + 1 THEN 'date_passed'
    WHEN p_date > current_date + public.schedule_booking_window_days(p_shop_id) THEN 'outside_window'
    WHEN public.schedule_date_is_blocked(p_shop_id, p_date) THEN 'date_blocked'
  END;
$$;

-- Per-shop advisory lock key (a hash collision only serializes two shops).
CREATE OR REPLACE FUNCTION public.schedule_availability_lock_key(p_shop_id uuid)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT hashtextextended('specplus.shop_availability:' || p_shop_id::text, 0);
$$;

-- Takes the shop's availability lock until the transaction ends: exclusive
-- to change availability, shared to check it before a dependent write.
CREATE OR REPLACE FUNCTION public.schedule_lock_availability(p_shop_id uuid, p_exclusive boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(public.schedule_availability_lock_key(p_shop_id));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(public.schedule_availability_lock_key(p_shop_id));
  END IF;
END;
$$;

-- Authorizes an admin or a writable shop user of the given shop for
-- availability settings (same rule as schedule_authorize, shop-level wording).
CREATE OR REPLACE FUNCTION public.schedule_authorize_shop(p_actor_id uuid, p_shop_id uuid)
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
  IF p_shop_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.shops s WHERE s.id = p_shop_id) THEN
    RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT p.role, p.shop_id INTO v_role, v_shop FROM public.profiles p WHERE p.id = p_actor_id;
  IF v_role = 'admin' THEN
    RETURN v_role;
  END IF;
  IF v_role IS DISTINCT FROM 'shop_user' OR v_shop IS DISTINCT FROM p_shop_id THEN
    RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF public.schedule_shop_is_read_only(p_shop_id) THEN
    RAISE EXCEPTION 'Your account is read-only. Reactivate your subscription to change availability.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END;
$$;

-- ===========================================================================
-- 4. Availability settings (staff)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.set_schedule_booking_window(p_shop_id uuid, p_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  PERFORM public.schedule_authorize_shop(v_uid, p_shop_id);
  IF p_days IS NULL OR p_days NOT BETWEEN 7 AND 365 THEN
    RAISE EXCEPTION 'The booking window must be between 7 and 365 days.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.schedule_lock_availability(p_shop_id, true);
  INSERT INTO public.shop_schedule_settings AS s (shop_id, booking_window_days, updated_by, updated_at)
  VALUES (p_shop_id, p_days, v_uid, now())
  ON CONFLICT (shop_id) DO UPDATE SET booking_window_days = EXCLUDED.booking_window_days,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN jsonb_build_object('ok', true, 'booking_window_days', p_days);
END;
$$;

-- Blocks (p_blocked = true) or unblocks every date in [p_start, p_end].
CREATE OR REPLACE FUNCTION public.set_schedule_dates_blocked(p_shop_id uuid, p_start date, p_end date, p_blocked boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_start date;
  v_changed integer;
BEGIN
  PERFORM public.schedule_authorize_shop(v_uid, p_shop_id);
  IF p_start IS NULL OR p_end IS NULL OR p_blocked IS NULL THEN
    RAISE EXCEPTION 'Choose a date or date range.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_end < p_start THEN
    RAISE EXCEPTION 'The end date must be on or after the start date.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_end - p_start > 365 THEN
    RAISE EXCEPTION 'Choose a range of one year or less.' USING ERRCODE = 'check_violation';
  END IF;
  -- Same one-day tolerance as schedule_start_date_is_open.
  IF p_end < current_date - 1 THEN
    RAISE EXCEPTION 'Past dates cannot be changed.' USING ERRCODE = 'check_violation';
  END IF;
  v_start := greatest(p_start, current_date - 1);

  -- Waits for in-flight requests/confirmations that checked availability.
  PERFORM public.schedule_lock_availability(p_shop_id, true);

  IF p_blocked THEN
    INSERT INTO public.shop_blocked_dates (shop_id, blocked_date, created_by)
    SELECT p_shop_id, d::date, v_uid FROM generate_series(v_start, p_end, interval '1 day') d
    ON CONFLICT (shop_id, blocked_date) DO NOTHING;
  ELSE
    DELETE FROM public.shop_blocked_dates b
    WHERE b.shop_id = p_shop_id AND b.blocked_date BETWEEN v_start AND p_end;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'changed', v_changed);
END;
$$;

-- ===========================================================================
-- 5. Staff scheduling functions (replaced)
-- ===========================================================================

-- As before, and blocked dates cannot be offered.
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
  v_blocked date;
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
  PERFORM public.schedule_lock_availability(v_lead.shop_id, false);
  SELECT min(d) INTO v_blocked FROM unnest(v_dates) d WHERE public.schedule_date_is_blocked(v_lead.shop_id, d);
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION '% is blocked on your calendar. Unblock it on the Schedule page or choose another date.',
      to_char(v_blocked, 'FMMonth FMDD, YYYY') USING ERRCODE = 'check_violation';
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

-- The only path that books a date. Accepts offered and calendar requests and
-- rechecks availability: a start date the shop has since blocked is refused.
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
  IF v_request.source = 'offer' THEN
    SELECT * INTO v_offer FROM public.schedule_offers o WHERE o.id = v_request.offer_id FOR UPDATE;
    IF v_offer.status <> 'active' THEN
      RAISE EXCEPTION 'The date options for this request were replaced.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT public.schedule_start_date_is_open(v_request.start_date) THEN
    RAISE EXCEPTION 'The requested start date has passed. Offer fresh dates or ask the customer to choose another date.' USING ERRCODE = 'check_violation';
  END IF;
  -- Held until commit, so the date can't be blocked before the booking lands.
  PERFORM public.schedule_lock_availability(v_lead.shop_id, false);
  IF public.schedule_date_is_blocked(v_lead.shop_id, v_request.start_date) THEN
    RAISE EXCEPTION 'The requested start date is blocked on your calendar. Unblock it on the Schedule page to confirm, or ask the customer to choose another date.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_quote := public.schedule_current_quote(v_lead.id);
  IF v_quote.id IS DISTINCT FROM v_request.quote_id
     OR (v_request.source = 'offer' AND v_quote.id IS DISTINCT FROM v_offer.quote_id)
     OR v_quote.status <> 'approved' OR v_quote.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'The quote changed after this date was requested. The customer must approve the current quote first.'
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
  IF v_offer.id IS NOT NULL THEN
    UPDATE public.schedule_offers SET status = 'closed', closed_at = now() WHERE id = v_offer.id;
  END IF;
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
      'revision_number', v_quote.revision_number,
      'source', v_request.source
    ));

  RETURN jsonb_build_object('ok', true, 'reservation_id', v_reservation_id,
    'version', public.schedule_bump_version(v_lead.id, v_lead.shop_id));
END;
$$;

-- ===========================================================================
-- 6. Customer functions (token-scoped)
-- ===========================================================================

-- Customer-safe scheduling state for one quote link: this project's active
-- options (with availability), its own pending request, its own booking, and
-- (when the customer may pick from the calendar) the booking window with the
-- shop's blocked dates inside it. Never other jobs, requests, names or notes.
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
  v_lead_status text;
  v_is_current boolean;
  v_booked boolean;
  v_earliest date;
  v_latest date;
  v_calendar jsonb;
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
  SELECT l.status INTO v_lead_status FROM public.leads l WHERE l.id = v_quote.lead_id;
  v_booked := EXISTS (SELECT 1 FROM public.schedule_reservations r WHERE r.lead_id = v_quote.lead_id AND r.status = 'active');

  IF v_is_current THEN
    SELECT * INTO v_offer FROM public.schedule_offers o
    WHERE o.lead_id = v_quote.lead_id AND o.status = 'active' AND o.quote_id = v_quote.id;
  END IF;

  IF v_is_current AND v_offer.id IS NULL AND NOT v_booked
     AND v_lead_status NOT IN ('in_progress', 'completed', 'lost', 'archived') THEN
    v_earliest := current_date + 1;
    v_latest := current_date + public.schedule_booking_window_days(v_quote.shop_id);
    v_calendar := jsonb_build_object(
      'earliest', v_earliest,
      'latest', v_latest,
      'blocked_dates', coalesce((
        SELECT jsonb_agg(b.blocked_date ORDER BY b.blocked_date) FROM public.shop_blocked_dates b
        WHERE b.shop_id = v_quote.shop_id AND b.blocked_date BETWEEN v_earliest AND v_latest
      ), '[]'::jsonb)
    );
  END IF;

  RETURN jsonb_build_object(
    'can_request', v_offer.id IS NOT NULL OR v_calendar IS NOT NULL,
    'offer', CASE WHEN v_offer.id IS NULL THEN NULL ELSE jsonb_build_object(
      'note', v_offer.customer_note,
      'is_reschedule', v_offer.is_reschedule,
      'options', (SELECT jsonb_agg(jsonb_build_object('id', o.id, 'start_date', o.start_date,
                    'available', public.schedule_start_date_is_open(o.start_date) AND NOT public.schedule_date_is_blocked(o.shop_id, o.start_date))
                  ORDER BY o.start_date)
                  FROM public.schedule_offer_options o WHERE o.offer_id = v_offer.id)
    ) END,
    'calendar', v_calendar,
    'request', (SELECT jsonb_build_object('option_id', r.option_id, 'start_date', r.start_date, 'requested_at', r.requested_at,
                  'source', r.source,
                  'available', public.schedule_start_date_is_open(r.start_date) AND NOT public.schedule_date_is_blocked(r.shop_id, r.start_date))
                FROM public.schedule_requests r
                WHERE v_is_current AND r.lead_id = v_quote.lead_id AND r.status = 'pending'
                  AND ((v_offer.id IS NOT NULL AND r.offer_id = v_offer.id)
                    OR (v_offer.id IS NULL AND r.source = 'calendar' AND r.quote_id = v_quote.id))),
    'booking', (SELECT jsonb_build_object('start_date', r.start_date, 'estimated_ready_date', r.estimated_ready_date)
                FROM public.schedule_reservations r
                WHERE r.lead_id = v_quote.lead_id AND r.status = 'active')
  );
END;
$$;

-- Choosing one of the shop's offered dates: as before, and a date the shop
-- has since blocked is refused.
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

  PERFORM public.schedule_lock_availability(v_lead.shop_id, false);
  IF public.schedule_date_is_blocked(v_lead.shop_id, v_option.start_date) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'date_blocked');
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
      'reschedule', v_offer.is_reschedule, 'changed_choice', v_pending.id IS NOT NULL, 'source', 'offer'));

  RETURN jsonb_build_object('ok', true, 'start_date', v_option.start_date, 'already_requested', false);
END;
$$;

-- Requesting a start date from the shop's calendar (no offered options).
CREATE OR REPLACE FUNCTION public.request_schedule_calendar_date(p_token uuid, p_start_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_current public.quotes%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_pending public.schedule_requests%ROWTYPE;
  v_problem text;
  v_request_id uuid;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  SELECT * INTO v_quote FROM public.quotes q WHERE q.public_token = p_token AND q.status <> 'draft';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF public.quote_viewer_is_staff(v_quote.shop_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_preview');
  END IF;

  -- Serializes with staff scheduling actions, quote revisions and other
  -- requests for this lead.
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_quote.lead_id FOR UPDATE;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = v_quote.id;
  v_current := public.schedule_current_quote(v_lead.id);
  IF v_quote.superseded_at IS NOT NULL OR v_current.id IS DISTINCT FROM v_quote.id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'superseded');
  END IF;
  IF v_quote.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quote_not_approved');
  END IF;
  IF v_lead.status IN ('in_progress', 'completed', 'lost', 'archived') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_available');
  END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_reservations r WHERE r.lead_id = v_lead.id AND r.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_scheduled');
  END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_offers o WHERE o.lead_id = v_lead.id AND o.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'use_offered_dates');
  END IF;

  -- Serializes with window and block/unblock changes until commit.
  PERFORM public.schedule_lock_availability(v_lead.shop_id, false);
  v_problem := public.schedule_calendar_date_problem(v_lead.shop_id, p_start_date);
  IF v_problem IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_problem);
  END IF;

  SELECT * INTO v_pending FROM public.schedule_requests r WHERE r.lead_id = v_lead.id AND r.status = 'pending';
  IF FOUND AND v_pending.source = 'calendar' AND v_pending.start_date = p_start_date THEN
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
  INSERT INTO public.schedule_requests (lead_id, shop_id, offer_id, option_id, quote_id, start_date, source)
  VALUES (v_lead.id, v_lead.shop_id, NULL, NULL, v_quote.id, p_start_date, 'calendar')
  RETURNING id INTO v_request_id;

  -- The project stays in the Scheduling stage until staff confirm.
  IF v_lead.status = 'approved' THEN
    UPDATE public.leads SET status = 'scheduling' WHERE id = v_lead.id;
  END IF;

  PERFORM public.schedule_bump_version(v_lead.id, v_lead.shop_id);
  PERFORM public.record_lead_event(v_lead.id, v_quote.id, 'schedule_date_requested',
    jsonb_build_object('request_id', v_request_id, 'start_date', p_start_date,
      'reschedule', false, 'changed_choice', v_pending.id IS NOT NULL, 'source', 'calendar'));

  RETURN jsonb_build_object('ok', true, 'start_date', p_start_date, 'already_requested', false);
END;
$$;

-- ===========================================================================
-- 7. RLS (read-only for the shop's staff and admins; nothing for anon)
-- ===========================================================================

ALTER TABLE public.shop_schedule_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_blocked_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_schedule_settings_admin_select" ON public.shop_schedule_settings;
CREATE POLICY "shop_schedule_settings_admin_select" ON public.shop_schedule_settings FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "shop_schedule_settings_shop_select" ON public.shop_schedule_settings;
CREATE POLICY "shop_schedule_settings_shop_select" ON public.shop_schedule_settings FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "shop_blocked_dates_admin_select" ON public.shop_blocked_dates;
CREATE POLICY "shop_blocked_dates_admin_select" ON public.shop_blocked_dates FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "shop_blocked_dates_shop_select" ON public.shop_blocked_dates;
CREATE POLICY "shop_blocked_dates_shop_select" ON public.shop_blocked_dates FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

REVOKE ALL PRIVILEGES ON TABLE public.shop_schedule_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.shop_blocked_dates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shop_schedule_settings TO authenticated;
GRANT SELECT ON TABLE public.shop_blocked_dates TO authenticated;

REVOKE ALL ON FUNCTION public.schedule_booking_window_days(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_date_is_blocked(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_calendar_date_problem(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_authorize_shop(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_availability_lock_key(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_lock_availability(uuid, boolean) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_schedule_booking_window(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_schedule_dates_blocked(uuid, date, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_schedule_booking_window(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_schedule_dates_blocked(uuid, date, date, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.request_schedule_calendar_date(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_schedule_calendar_date(uuid, date) TO anon, authenticated;

COMMIT;
