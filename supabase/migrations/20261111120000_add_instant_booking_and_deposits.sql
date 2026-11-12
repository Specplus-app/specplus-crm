/*
# Instant customer booking and optional deposits

Builds on 20261007120000_add_production_scheduling.sql,
20261014120000_add_notifications.sql,
20261015120000_notification_recovery_and_device_sync.sql and
20261028120000_add_customer_calendar_scheduling.sql (already applied; not
edited).

Customer flow (book_schedule_date, token-scoped):
  1. The customer approves the current quote.
  2. They pick an available day on the shop's calendar and click "Book It".
  3. One transaction rechecks the token, the current approved quote, the
     lead's status, staff preview, and the booking window and blocked dates
     (under the lead lock, then the shop's shared availability lock), then
     creates the active reservation, moves the lead to Scheduled and records
     a schedule_booked event. No staff confirmation.
  4. The booking's start date is confirmed; its estimated-ready date stays
     NULL ("not yet provided") until staff set it (set_schedule_ready_date),
     which is an edit, not another approval.
  Retries are idempotent by state: a lead that already has an active
  booking for the same start date returns it (already_booked) without new
  rows, history or notifications; any other date is refused. Concurrent
  double clicks serialize on the lead lock.
  Read-only (billing) shops take no NEW bookings (schedule_shop_is_read_only,
  the rule confirm_schedule applied through schedule_authorize): the
  customer sees a generic "booking unavailable" message, and existing
  bookings and retries of them are unaffected.

Deposits (optional, shown after booking; never processed by SpecPlus):
  - shop_deposit_settings: "request a deposit after booking" (off by
    default), external HTTPS payment URL, optional fixed amount (USD, like
    quotes) and customer instructions.
  - lead_deposits: the deposit for one lead. Created at booking time as a
    snapshot of the shop defaults (if no row exists yet), so later changes
    to the defaults never rewrite existing bookings. Staff can override the
    link, amount and instructions per lead (e.g. a customer-specific
    invoice) before or after booking, and confirm receipt. Status:
      not_required (no row, or requested = false)
      awaiting     (requested, not received)
      received     (received_at set; received_by records who)
    A payment-link click is never recorded or treated as payment. While a
    deposit is marked received its amount is locked (and the request can't
    be turned off); staff undo the receipt first. Its link and instructions
    can still be corrected.
  - The deposit snapshot runs in its own subtransaction: a configuration
    problem is logged and skipped and can never undo or block the booking.
  - Payment URLs must be https://, with a hostname, no credentials, and no
    spaces or control characters. They are never fetched by the server.

Notifications: schedule_booked maps to a new kind, date_booked ("A customer
booked a production date"), delivered like date_requested (in-app and push
to the shop's staff; no email). Enqueueing is already isolated from the
action, and notification_events.lead_event_id is unique, so a booking makes
exactly one notification event.

Legacy behavior kept as is:
  - Existing reservations, requests, offers and history are unchanged.
    Existing reservations keep their estimated-ready dates and have no
    deposit row ("not required").
  - Pending customer requests from the request flow stay visible and are
    still confirmed with confirm_schedule (which still requires a ready
    date). A customer who books from the calendar replaces their own pending
    calendar request (status replaced).
  - Offered dates, rescheduling and cancellation work as before.
    request_schedule_calendar_date is kept for clients that still call it.

Security: new tables are SELECT-only for the shop's own staff and admins
(RLS) and closed to anon. Writes go through the functions below; staff
functions use schedule_authorize / schedule_authorize_shop (admin, or a
writable shop_user of that shop; read-only billing shops are refused).
Customers can only book through their quote token and never see payment
administration fields (who received it, when, or internal notes).
*/

BEGIN;

-- ===========================================================================
-- 1. Reservations: optional ready date, booking source
-- ===========================================================================

ALTER TABLE public.schedule_reservations ALTER COLUMN estimated_ready_date DROP NOT NULL;
ALTER TABLE public.schedule_reservations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'customer'));

-- Same guard as 20261028120000, except that an active reservation's
-- estimated-ready date may be set or changed (set_schedule_ready_date), and a
-- reservation's source is immutable.
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
        NEW.internal_notes, NEW.confirmed_by, NEW.confirmed_at, NEW.source)
       IS DISTINCT FROM
       (OLD.id, OLD.lead_id, OLD.shop_id, OLD.quote_id, OLD.quote_revision_number, OLD.request_id, OLD.start_date,
        OLD.internal_notes, OLD.confirmed_by, OLD.confirmed_at, OLD.source)
      OR (OLD.status <> 'active' AND NEW.estimated_ready_date IS DISTINCT FROM OLD.estimated_ready_date)
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
-- 2. Deposit tables
-- ===========================================================================

-- Safe external payment link: https only, a dotted hostname (optional port),
-- no user:password@ credentials, no whitespace, quotes or angle brackets.
CREATE OR REPLACE FUNCTION public.deposit_url_is_safe(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_url IS NOT NULL
    AND char_length(p_url) BETWEEN 12 AND 2000
    AND p_url ~ '^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]<>"''`\\]*)?$';
$$;

CREATE TABLE IF NOT EXISTS public.shop_deposit_settings (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  payment_url text CHECK (payment_url IS NULL OR public.deposit_url_is_safe(payment_url)),
  amount numeric(10, 2) CHECK (amount IS NULL OR amount BETWEEN 0.01 AND 1000000),
  instructions text CHECK (instructions IS NULL OR (instructions = btrim(instructions) AND char_length(instructions) BETWEEN 1 AND 1000)),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_deposit_settings_enabled_has_details CHECK (NOT enabled OR payment_url IS NOT NULL OR instructions IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.lead_deposits (
  lead_id uuid PRIMARY KEY REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  requested boolean NOT NULL DEFAULT false,
  payment_url text CHECK (payment_url IS NULL OR public.deposit_url_is_safe(payment_url)),
  amount numeric(10, 2) CHECK (amount IS NULL OR amount BETWEEN 0.01 AND 1000000),
  instructions text CHECK (instructions IS NULL OR (instructions = btrim(instructions) AND char_length(instructions) BETWEEN 1 AND 1000)),
  -- 'shop_default': snapshot taken at booking; 'staff': set on the lead.
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('shop_default', 'staff')),
  received_at timestamptz,
  received_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT lead_deposits_received_was_requested CHECK (received_at IS NULL OR requested)
);

CREATE INDEX IF NOT EXISTS idx_lead_deposits_shop ON public.lead_deposits(shop_id);

-- ===========================================================================
-- 3. Internal helpers (not executable by clients)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.deposit_status_of(p_deposit public.lead_deposits)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_deposit.lead_id IS NULL OR NOT p_deposit.requested THEN 'not_required'
    WHEN p_deposit.received_at IS NOT NULL THEN 'received'
    ELSE 'awaiting'
  END;
$$;

-- Validates and normalizes deposit details from staff input.
CREATE OR REPLACE FUNCTION public.deposit_clean_details(p_payment_url text, p_amount numeric, p_instructions text)
RETURNS TABLE (payment_url text, amount numeric, instructions text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_url text := nullif(btrim(coalesce(p_payment_url, '')), '');
  v_instructions text := nullif(btrim(coalesce(p_instructions, '')), '');
BEGIN
  IF v_url IS NOT NULL AND NOT public.deposit_url_is_safe(v_url) THEN
    RAISE EXCEPTION 'Enter a secure payment link starting with https:// (no spaces or sign-in details).'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NOT NULL AND (p_amount < 0.01 OR p_amount > 1000000 OR p_amount <> round(p_amount, 2)) THEN
    RAISE EXCEPTION 'Enter a deposit amount between $0.01 and $1,000,000, in dollars and cents.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_instructions IS NOT NULL AND char_length(v_instructions) > 1000 THEN
    RAISE EXCEPTION 'Payment instructions must be 1000 characters or fewer.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY SELECT v_url, p_amount, v_instructions;
END;
$$;

-- Snapshots the shop's deposit defaults for a newly booked lead, unless the
-- lead already has deposit details. Never raises: a problem is logged and the
-- booking goes ahead without a deposit request.
CREATE OR REPLACE FUNCTION public.deposit_snapshot_for_booking(p_lead_id uuid, p_shop_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_settings public.shop_deposit_settings%ROWTYPE;
  v_requested boolean := false;
BEGIN
  BEGIN
    IF EXISTS (SELECT 1 FROM public.lead_deposits d WHERE d.lead_id = p_lead_id) THEN
      SELECT d.requested INTO v_requested FROM public.lead_deposits d WHERE d.lead_id = p_lead_id;
      RETURN v_requested;
    END IF;
    SELECT * INTO v_settings FROM public.shop_deposit_settings s WHERE s.shop_id = p_shop_id;
    IF coalesce(v_settings.enabled, false) THEN
      INSERT INTO public.lead_deposits (lead_id, shop_id, requested, payment_url, amount, instructions, source)
      VALUES (p_lead_id, p_shop_id, true,
        CASE WHEN public.deposit_url_is_safe(v_settings.payment_url) THEN v_settings.payment_url END,
        v_settings.amount, v_settings.instructions, 'shop_default');
      v_requested := true;
    END IF;
    RETURN v_requested;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Deposit snapshot skipped for lead %: % (%)', p_lead_id, SQLERRM, SQLSTATE;
    RETURN false;
  END;
END;
$$;

-- ===========================================================================
-- 4. Notifications: "date_booked"
-- ===========================================================================

ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE public.notification_events ADD CONSTRAINT notification_events_kind_check CHECK (kind IN (
  'new_request', 'customer_message', 'shop_reply', 'quote_approved',
  'quote_declined', 'date_requested', 'date_booked', 'status_changed'
));

CREATE OR REPLACE FUNCTION public.notification_kind_for(p_event public.lead_events)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    -- Leads are only created by the public request forms (custom and
    -- preconfigured), which also accept signed-in browsers, so every new lead
    -- is a request regardless of who submitted it.
    WHEN p_event.event_type = 'lead_created'
      AND coalesce(p_event.metadata ->> 'backfilled', '') NOT IN ('true', 't')
      THEN 'new_request'
    WHEN p_event.event_type = 'quote_message_added'
      THEN CASE WHEN p_event.metadata ->> 'sender_type' = 'customer' THEN 'customer_message' ELSE 'shop_reply' END
    WHEN p_event.event_type IN ('quote_approved', 'quote_declined')
      THEN p_event.event_type
    WHEN p_event.event_type = 'schedule_date_requested'
      THEN 'date_requested'
    WHEN p_event.event_type = 'schedule_booked'
      THEN 'date_booked'
    WHEN p_event.event_type = 'status_changed'
      AND p_event.actor_type IN ('shop_user', 'admin')
      AND p_event.metadata ->> 'to' IN ('scheduled', 'in_progress', 'completed', 'lost')
      THEN 'status_changed'
  END;
$$;

-- As in 20261014120000, with lock-screen copy for date_booked.
CREATE OR REPLACE FUNCTION public.notification_delivery_payload(p_delivery public.notification_deliveries)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.notification_events%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_shop public.shops%ROWTYPE;
  v_sub public.push_subscriptions%ROWTYPE;
  v_to text;
  v_token uuid;
  v_title text;
  v_body text;
BEGIN
  SELECT * INTO v_event FROM public.notification_events e WHERE e.id = p_delivery.event_id;
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_event.lead_id;
  SELECT * INTO v_shop FROM public.shops s WHERE s.id = v_event.shop_id;
  IF v_lead.id IS NULL OR v_shop.id IS NULL OR v_lead.shop_id IS DISTINCT FROM v_event.shop_id THEN
    RETURN jsonb_build_object('skip', 'lead_unavailable');
  END IF;

  IF p_delivery.channel = 'email' AND p_delivery.recipient_type = 'shop' THEN
    v_to := btrim(coalesce(v_shop.contact_email, ''));
    IF v_to !~ '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$' THEN
      RETURN jsonb_build_object('skip', 'no_shop_email');
    END IF;
    RETURN jsonb_build_object(
      'kind', v_event.kind,
      'to', v_to,
      'shop_name', v_shop.name,
      'lead_id', v_lead.id,
      'lead_path', '/dashboard/leads/' || v_lead.id,
      'customer_name', v_lead.customer_name,
      'customer_email', v_lead.customer_email,
      'vehicle_name', v_lead.vehicle_name,
      'is_custom', v_lead.is_custom
    );
  END IF;

  IF p_delivery.channel = 'email' AND p_delivery.recipient_type = 'customer' THEN
    v_to := btrim(coalesce(v_lead.customer_email, ''));
    IF v_to !~ '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$' THEN
      RETURN jsonb_build_object('skip', 'no_customer_email');
    END IF;
    -- Always link to the customer's current quote, even if the reply was
    -- written on a revision that has since been superseded.
    SELECT q.public_token INTO v_token
    FROM public.quotes q
    WHERE q.lead_id = v_lead.id AND q.status <> 'draft' AND q.superseded_at IS NULL
    ORDER BY q.revision_number DESC
    LIMIT 1;
    IF v_token IS NULL THEN
      RETURN jsonb_build_object('skip', 'no_current_quote');
    END IF;
    RETURN jsonb_build_object(
      'kind', v_event.kind,
      'to', v_to,
      'shop_name', v_shop.name,
      'shop_email', v_shop.contact_email,
      'customer_name', v_lead.customer_name,
      'vehicle_name', v_lead.vehicle_name,
      'quote_path', '/q/' || v_token
    );
  END IF;

  IF p_delivery.channel = 'push' THEN
    IF p_delivery.subscription_id IS NULL THEN
      RETURN jsonb_build_object('skip', 'unsubscribed');
    END IF;
    SELECT * INTO v_sub FROM public.push_subscriptions s WHERE s.id = p_delivery.subscription_id;
    IF v_sub.id IS NULL THEN
      RETURN jsonb_build_object('skip', 'unsubscribed');
    END IF;
    -- The device was signed in to by someone else since this was queued.
    IF v_sub.user_id IS DISTINCT FROM p_delivery.user_id THEN
      RETURN jsonb_build_object('skip', 'subscription_reassigned');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_delivery.user_id AND p.role = 'shop_user' AND p.shop_id = v_event.shop_id
    ) THEN
      RETURN jsonb_build_object('skip', 'not_authorized');
    END IF;
    IF NOT public.push_endpoint_is_allowed(v_sub.endpoint) THEN
      RETURN jsonb_build_object('skip', 'endpoint_not_allowed');
    END IF;

    -- Generic lock-screen copy: no customer details or message bodies.
    v_title := CASE v_event.kind
      WHEN 'new_request' THEN 'New request'
      WHEN 'customer_message' THEN 'New customer message'
      WHEN 'quote_approved' THEN 'Quote approved'
      WHEN 'quote_declined' THEN 'Quote declined'
      WHEN 'date_requested' THEN 'Production date selected'
      WHEN 'date_booked' THEN 'Production date booked'
      ELSE 'Lead updated'
    END;
    v_body := CASE v_event.kind
      WHEN 'new_request' THEN 'A customer submitted a new request.'
      WHEN 'customer_message' THEN 'A customer sent a message about a quote.'
      WHEN 'quote_approved' THEN 'A customer approved a quote.'
      WHEN 'quote_declined' THEN 'A customer declined a quote.'
      WHEN 'date_requested' THEN 'A customer selected a production date.'
      WHEN 'date_booked' THEN 'A customer booked a production date.'
      ELSE 'A lead moved to ' || CASE v_event.metadata ->> 'to'
        WHEN 'scheduled' THEN 'Scheduled'
        WHEN 'in_progress' THEN 'In Progress'
        WHEN 'completed' THEN 'Completed'
        WHEN 'lost' THEN 'Lost'
        ELSE 'a new stage'
      END || '.'
    END;

    RETURN jsonb_build_object(
      'kind', v_event.kind,
      'endpoint', v_sub.endpoint,
      'p256dh', v_sub.p256dh,
      'auth', v_sub.auth,
      'subscription_id', v_sub.id,
      'notification', jsonb_build_object(
        'title', v_title,
        'body', v_body,
        'url', '/dashboard/leads/' || v_lead.id,
        'tag', v_event.id
      )
    );
  END IF;

  RETURN jsonb_build_object('skip', 'unknown_channel');
END;
$$;

-- ===========================================================================
-- 5. Customer functions (token-scoped)
-- ===========================================================================

-- Books a start date from the shop's calendar immediately.
CREATE OR REPLACE FUNCTION public.book_schedule_date(p_token uuid, p_start_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_current public.quotes%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_booking public.schedule_reservations%ROWTYPE;
  v_pending public.schedule_requests%ROWTYPE;
  v_problem text;
  v_reservation_id uuid;
  v_deposit boolean;
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

  -- Serializes with staff scheduling actions, quote revisions and repeated
  -- clicks for this lead.
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_quote.lead_id FOR UPDATE;
  IF v_lead.shop_id IS DISTINCT FROM v_quote.shop_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- A retry after a lost response, or a second click, returns the booking.
  SELECT * INTO v_booking FROM public.schedule_reservations r WHERE r.lead_id = v_lead.id AND r.status = 'active';
  IF FOUND THEN
    IF v_booking.start_date = p_start_date THEN
      RETURN jsonb_build_object('ok', true, 'start_date', v_booking.start_date, 'already_booked', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'already_scheduled');
  END IF;

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
  IF EXISTS (SELECT 1 FROM public.schedule_offers o WHERE o.lead_id = v_lead.id AND o.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'use_offered_dates');
  END IF;
  -- Read-only (billing) shops take no new bookings, as confirm_schedule's
  -- schedule_authorize refused before. The customer gets a generic message;
  -- existing bookings and retries of them (above) are unaffected.
  IF public.schedule_shop_is_read_only(v_lead.shop_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'booking_unavailable');
  END IF;

  -- Held until commit, so the date can't be blocked before the booking lands.
  PERFORM public.schedule_lock_availability(v_lead.shop_id, false);
  v_problem := public.schedule_calendar_date_problem(v_lead.shop_id, p_start_date);
  IF v_problem IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_problem);
  END IF;

  PERFORM set_config('specplus.actor_type', 'customer', true);
  PERFORM set_config('specplus.actor_id', '', true);

  -- The customer's own earlier calendar request is replaced by the booking.
  SELECT * INTO v_pending FROM public.schedule_requests r WHERE r.lead_id = v_lead.id AND r.status = 'pending';
  IF FOUND THEN
    UPDATE public.schedule_requests SET status = 'replaced', resolved_at = now() WHERE id = v_pending.id;
  END IF;

  INSERT INTO public.schedule_reservations (lead_id, shop_id, quote_id, quote_revision_number, request_id,
    start_date, estimated_ready_date, internal_notes, confirmed_by, source)
  VALUES (v_lead.id, v_lead.shop_id, v_quote.id, v_quote.revision_number, NULL,
    p_start_date, NULL, NULL, NULL, 'customer')
  RETURNING id INTO v_reservation_id;

  IF v_lead.status <> 'scheduled' THEN
    UPDATE public.leads SET status = 'scheduled' WHERE id = v_lead.id;
  END IF;

  v_deposit := public.deposit_snapshot_for_booking(v_lead.id, v_lead.shop_id);

  PERFORM public.schedule_bump_version(v_lead.id, v_lead.shop_id);
  PERFORM public.record_lead_event(v_lead.id, v_quote.id, 'schedule_booked',
    jsonb_build_object('reservation_id', v_reservation_id, 'start_date', p_start_date,
      'revision_number', v_quote.revision_number, 'replaced_request', v_pending.id IS NOT NULL,
      'deposit_requested', v_deposit));

  RETURN jsonb_build_object('ok', true, 'start_date', p_start_date, 'already_booked', false);
END;
$$;

-- Customer-safe scheduling state for one quote link (replaces the
-- 20261028120000 version): as before, and the booking's ready date may be
-- null, and an active booking carries its deposit request (amount, link,
-- instructions and awaiting/received only).
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
  v_deposit public.lead_deposits%ROWTYPE;
  v_lead_status text;
  v_is_current boolean;
  v_booked boolean;
  v_earliest date;
  v_latest date;
  v_calendar jsonb;
  v_unavailable boolean;
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

  -- A read-only (billing) shop takes no new bookings: no calendar, just a
  -- generic "booking unavailable" flag (no billing details).
  v_unavailable := v_is_current AND v_offer.id IS NULL AND NOT v_booked
    AND v_lead_status NOT IN ('in_progress', 'completed', 'lost', 'archived')
    AND public.schedule_shop_is_read_only(v_quote.shop_id);

  IF v_is_current AND v_offer.id IS NULL AND NOT v_booked AND NOT v_unavailable
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

  IF v_booked THEN
    SELECT * INTO v_deposit FROM public.lead_deposits d WHERE d.lead_id = v_quote.lead_id AND d.requested;
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
    'booking_unavailable', coalesce(v_unavailable, false),
    'request', (SELECT jsonb_build_object('option_id', r.option_id, 'start_date', r.start_date, 'requested_at', r.requested_at,
                  'source', r.source,
                  'available', public.schedule_start_date_is_open(r.start_date) AND NOT public.schedule_date_is_blocked(r.shop_id, r.start_date))
                FROM public.schedule_requests r
                WHERE v_is_current AND r.lead_id = v_quote.lead_id AND r.status = 'pending'
                  AND ((v_offer.id IS NOT NULL AND r.offer_id = v_offer.id)
                    OR (v_offer.id IS NULL AND r.source = 'calendar' AND r.quote_id = v_quote.id))),
    'booking', (SELECT jsonb_build_object('start_date', r.start_date, 'estimated_ready_date', r.estimated_ready_date)
                FROM public.schedule_reservations r
                WHERE r.lead_id = v_quote.lead_id AND r.status = 'active'),
    'deposit', CASE WHEN v_deposit.lead_id IS NULL THEN NULL ELSE jsonb_build_object(
      'status', public.deposit_status_of(v_deposit),
      'amount', v_deposit.amount,
      'payment_url', CASE WHEN public.deposit_url_is_safe(v_deposit.payment_url) THEN v_deposit.payment_url END,
      'instructions', v_deposit.instructions
    ) END
  );
END;
$$;

-- ===========================================================================
-- 6. Staff functions
-- ===========================================================================

-- Sets (or changes) the active booking's estimated-ready date. An edit of the
-- booking, not another confirmation.
CREATE OR REPLACE FUNCTION public.set_schedule_ready_date(p_lead_id uuid, p_expected_version integer, p_ready_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lead public.leads%ROWTYPE;
  v_booking public.schedule_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.schedule_authorize(v_uid, v_lead.shop_id);
  PERFORM public.schedule_check_version(v_lead.id, p_expected_version);

  SELECT * INTO v_booking FROM public.schedule_reservations r
  WHERE r.lead_id = v_lead.id AND r.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no confirmed schedule to update.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_ready_date IS NULL OR p_ready_date < v_booking.start_date THEN
    RAISE EXCEPTION 'The estimated-ready date must be on or after the start date.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_ready_date IS NOT DISTINCT FROM v_booking.estimated_ready_date THEN
    RETURN jsonb_build_object('ok', true, 'version', public.schedule_version_of(v_lead.id), 'unchanged', true);
  END IF;

  UPDATE public.schedule_reservations SET estimated_ready_date = p_ready_date WHERE id = v_booking.id;
  PERFORM public.record_lead_event(v_lead.id, v_booking.quote_id, 'schedule_ready_date_set',
    jsonb_build_object('reservation_id', v_booking.id, 'start_date', v_booking.start_date,
      'estimated_ready_date', p_ready_date, 'previous_estimated_ready_date', v_booking.estimated_ready_date));

  RETURN jsonb_build_object('ok', true, 'version', public.schedule_bump_version(v_lead.id, v_lead.shop_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_shop_deposit_settings(
  p_shop_id uuid,
  p_enabled boolean,
  p_payment_url text,
  p_amount numeric,
  p_instructions text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clean record;
BEGIN
  PERFORM public.schedule_authorize_shop(v_uid, p_shop_id);
  SELECT * INTO v_clean FROM public.deposit_clean_details(p_payment_url, p_amount, p_instructions);
  IF coalesce(p_enabled, false) AND v_clean.payment_url IS NULL AND v_clean.instructions IS NULL THEN
    RAISE EXCEPTION 'Add a payment link or payment instructions before requesting deposits.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.shop_deposit_settings AS s (shop_id, enabled, payment_url, amount, instructions, updated_by, updated_at)
  VALUES (p_shop_id, coalesce(p_enabled, false), v_clean.payment_url, v_clean.amount, v_clean.instructions, v_uid, now())
  ON CONFLICT (shop_id) DO UPDATE SET enabled = EXCLUDED.enabled, payment_url = EXCLUDED.payment_url,
    amount = EXCLUDED.amount, instructions = EXCLUDED.instructions, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Sets the lead's deposit request and details (overrides the shop defaults
-- for this lead, before or after booking).
CREATE OR REPLACE FUNCTION public.set_lead_deposit(
  p_lead_id uuid,
  p_requested boolean,
  p_payment_url text,
  p_amount numeric,
  p_instructions text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lead public.leads%ROWTYPE;
  v_old public.lead_deposits%ROWTYPE;
  v_clean record;
  v_changed text[] := '{}';
BEGIN
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.schedule_authorize(v_uid, v_lead.shop_id);
  SELECT * INTO v_clean FROM public.deposit_clean_details(p_payment_url, p_amount, p_instructions);

  SELECT * INTO v_old FROM public.lead_deposits d WHERE d.lead_id = v_lead.id FOR UPDATE;
  IF v_old.received_at IS NOT NULL AND NOT coalesce(p_requested, false) THEN
    RAISE EXCEPTION 'The deposit is marked as received. Undo that before turning off the deposit request.' USING ERRCODE = 'check_violation';
  END IF;
  -- A received amount is what was confirmed as paid: it can't change
  -- (including to or from "no amount") until staff undo the receipt.
  -- The link and instructions can still be corrected.
  IF v_old.received_at IS NOT NULL AND v_old.amount IS DISTINCT FROM v_clean.amount THEN
    RAISE EXCEPTION 'The deposit is marked as received, so its amount can''t change. Undo "received" first, then edit the amount.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(v_old.requested, false) IS DISTINCT FROM coalesce(p_requested, false) THEN v_changed := v_changed || 'requested'::text; END IF;
  IF v_old.payment_url IS DISTINCT FROM v_clean.payment_url THEN v_changed := v_changed || 'payment_url'::text; END IF;
  IF v_old.amount IS DISTINCT FROM v_clean.amount THEN v_changed := v_changed || 'amount'::text; END IF;
  IF v_old.instructions IS DISTINCT FROM v_clean.instructions THEN v_changed := v_changed || 'instructions'::text; END IF;
  IF cardinality(v_changed) = 0 AND v_old.lead_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true);
  END IF;

  INSERT INTO public.lead_deposits AS d (lead_id, shop_id, requested, payment_url, amount, instructions, source, updated_by, updated_at)
  VALUES (v_lead.id, v_lead.shop_id, coalesce(p_requested, false), v_clean.payment_url, v_clean.amount, v_clean.instructions, 'staff', v_uid, now())
  ON CONFLICT (lead_id) DO UPDATE SET requested = EXCLUDED.requested, payment_url = EXCLUDED.payment_url,
    amount = EXCLUDED.amount, instructions = EXCLUDED.instructions, source = 'staff',
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  PERFORM public.record_lead_event(v_lead.id, NULL, 'deposit_updated',
    jsonb_build_object('requested', coalesce(p_requested, false), 'amount', v_clean.amount,
      'has_payment_link', v_clean.payment_url IS NOT NULL, 'changed', to_jsonb(v_changed)));
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Confirms (or undoes) receipt of the deposit. Only staff can do this; the
-- event records who.
CREATE OR REPLACE FUNCTION public.set_deposit_received(p_lead_id uuid, p_received boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lead public.leads%ROWTYPE;
  v_deposit public.lead_deposits%ROWTYPE;
BEGIN
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.schedule_authorize(v_uid, v_lead.shop_id);
  SELECT * INTO v_deposit FROM public.lead_deposits d WHERE d.lead_id = v_lead.id FOR UPDATE;
  IF NOT FOUND OR NOT v_deposit.requested THEN
    RAISE EXCEPTION 'No deposit is requested for this lead.' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(p_received, false) = (v_deposit.received_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true);
  END IF;

  IF p_received THEN
    UPDATE public.lead_deposits SET received_at = now(), received_by = v_uid, updated_by = v_uid, updated_at = now()
    WHERE lead_id = v_lead.id;
    PERFORM public.record_lead_event(v_lead.id, NULL, 'deposit_received', jsonb_build_object('amount', v_deposit.amount));
  ELSE
    UPDATE public.lead_deposits SET received_at = NULL, received_by = NULL, updated_by = v_uid, updated_at = now()
    WHERE lead_id = v_lead.id;
    PERFORM public.record_lead_event(v_lead.id, NULL, 'deposit_receipt_undone',
      jsonb_build_object('amount', v_deposit.amount, 'previously_received_at', v_deposit.received_at));
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ===========================================================================
-- 7. RLS (read-only for the shop's staff and admins; nothing for anon)
-- ===========================================================================

ALTER TABLE public.shop_deposit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_deposits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_deposit_settings_admin_select" ON public.shop_deposit_settings;
CREATE POLICY "shop_deposit_settings_admin_select" ON public.shop_deposit_settings FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "shop_deposit_settings_shop_select" ON public.shop_deposit_settings;
CREATE POLICY "shop_deposit_settings_shop_select" ON public.shop_deposit_settings FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

DROP POLICY IF EXISTS "lead_deposits_admin_select" ON public.lead_deposits;
CREATE POLICY "lead_deposits_admin_select" ON public.lead_deposits FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');
DROP POLICY IF EXISTS "lead_deposits_shop_select" ON public.lead_deposits;
CREATE POLICY "lead_deposits_shop_select" ON public.lead_deposits FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

REVOKE ALL PRIVILEGES ON TABLE public.shop_deposit_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.lead_deposits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shop_deposit_settings TO authenticated;
GRANT SELECT ON TABLE public.lead_deposits TO authenticated;

REVOKE ALL ON FUNCTION public.deposit_url_is_safe(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deposit_status_of(public.lead_deposits) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deposit_clean_details(text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deposit_snapshot_for_booking(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_kind_for(public.lead_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_delivery_payload(public.notification_deliveries) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_schedule_ready_date(uuid, integer, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_shop_deposit_settings(uuid, boolean, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_lead_deposit(uuid, boolean, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_deposit_received(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_schedule_ready_date(uuid, integer, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_shop_deposit_settings(uuid, boolean, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_deposit(uuid, boolean, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_deposit_received(uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.book_schedule_date(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_schedule_date(uuid, date) TO anon, authenticated;

COMMIT;
