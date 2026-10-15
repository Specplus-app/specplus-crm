/*
# Notifications: durable events with email, Web Push and in-app delivery

Builds on the lead lifecycle, quote conversation and scheduling migrations
(already applied; not edited).

1. Source of truth
   - Every notification starts from a row in the existing append-only
     `lead_events` audit table. An AFTER INSERT trigger turns the notifiable
     ones into a `notification_events` row in the SAME transaction (outbox
     pattern): if the underlying action rolls back, nothing is notified; if it
     commits, the notification is durable.
   - The trigger body runs in its own exception block. A notification fault is
     logged as a WARNING and can never fail or roll back the customer's
     submission, message, approval or date request.
   - Only events written after this migration are notified. Nothing is
     backfilled from historical lead_events.

2. Event → channel routing (recipients resolved here, server-side)
     new_request       new lead from a request form (custom or preconfigured)
                       → email shop contact_email, push + in-app to shop staff
     customer_message  customer quote message → email shop, push + in-app
     shop_reply        shop/admin quote message → email the customer
     quote_approved / quote_declined           → push + in-app
     date_requested    customer production date selection → push + in-app
     status_changed    staff moved a lead to scheduled / in_progress /
                       completed / lost → push + in-app
   Staff recipients are `shop_user` profiles of the lead's shop. The member
   who performed the action is never notified about it.
   Flood protection on the unauthenticated paths: at most one customer-
   message email per lead per 10 minutes and 50 new-request emails per shop
   per hour (push and in-app still record every event).

3. Delivery tracking
   - `notification_deliveries`: one row per (event, channel, recipient),
     unique, so an event can never be queued twice for the same recipient.
     Outcomes (sent / failed / skipped, attempts, last error) are tracked per
     channel and per device.
   - `claim_notification_deliveries` (service_role only) leases due rows with
     FOR UPDATE SKIP LOCKED, RE-CHECKS authorization and recipients at that
     moment (shop membership, subscription ownership, current contact email,
     current customer quote link) and returns the resolved payload.
   - `complete_notification_delivery` (service_role only) records the outcome
     against the lease token. Retries back off 1, 2, 4, 8 minutes and stop
     after 5 attempts; undelivered work older than 24 hours is abandoned.
     An expired push subscription (404/410) is deleted.

4. Device subscriptions and inbox
   - `push_subscriptions`: one row per browser/device endpoint. Users manage
     only their own via register_/delete_push_subscription. Endpoints must be
     https URLs on a known push service (the dispatcher POSTs to them).
   - `notifications`: in-app history per staff user, read state via
     mark_notifications_read (own rows only).

5. Security
   - RLS on every new table. Users read only their own subscriptions and
     notifications (and inbox rows only for their current shop). No client
     INSERT/UPDATE/DELETE grants; notification_events and deliveries have no
     client access at all.
   - All SECURITY DEFINER functions use `SET search_path = ''`, fully
     qualified names, and explicit EXECUTE revokes/grants.
*/

BEGIN;

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.push_endpoint_is_allowed(p_endpoint text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_endpoint IS NOT NULL
    AND char_length(p_endpoint) <= 1000
    AND p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[!-~]*$';
$$;

CREATE TABLE IF NOT EXISTS public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_event_id uuid NOT NULL REFERENCES public.lead_events(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN (
    'new_request', 'customer_message', 'shop_reply', 'quote_approved',
    'quote_declined', 'date_requested', 'status_changed'
  )),
  actor_id uuid,
  -- Structural details only (e.g. the new status); never message bodies.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_events_lead_event_key UNIQUE (lead_event_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_events_lead ON public.notification_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_notification_events_shop_kind_created
  ON public.notification_events(shop_id, kind, created_at);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (public.push_endpoint_is_allowed(endpoint)),
  -- Uncompressed P-256 public key (65 bytes) and auth secret (16 bytes), base64url.
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22,24}$'),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.notification_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_event_user_key UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON public.notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.notification_events(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'push')),
  recipient_type text NOT NULL CHECK (recipient_type IN ('shop', 'customer', 'staff')),
  -- 'shop' | 'customer' | the push subscription id: one row per recipient.
  recipient_key text NOT NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.push_subscriptions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  provider_message_id text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_recipient_key UNIQUE (event_id, channel, recipient_key),
  CONSTRAINT notification_deliveries_push_target CHECK (
    (channel = 'push') = (recipient_type = 'staff' AND user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON public.notification_deliveries(next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_subscription
  ON public.notification_deliveries(subscription_id);

-- ===========================================================================
-- 2. Enqueue (lead_events → notification_events + deliveries + inbox)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.notification_enqueue(p_event public.lead_events)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_meta jsonb := '{}'::jsonb;
  v_event_id uuid;
  v_email_to text;
  v_staff boolean;
BEGIN
  -- Leads are only created by the public request forms (custom and
  -- preconfigured), which also accept signed-in browsers, so every new lead
  -- is a request regardless of who submitted it.
  IF p_event.event_type = 'lead_created'
     AND NOT coalesce((p_event.metadata ->> 'backfilled')::boolean, false) THEN
    v_kind := 'new_request';
  ELSIF p_event.event_type = 'quote_message_added' THEN
    v_kind := CASE WHEN p_event.metadata ->> 'sender_type' = 'customer' THEN 'customer_message' ELSE 'shop_reply' END;
  ELSIF p_event.event_type IN ('quote_approved', 'quote_declined') THEN
    v_kind := p_event.event_type;
  ELSIF p_event.event_type = 'schedule_date_requested' THEN
    v_kind := 'date_requested';
  ELSIF p_event.event_type = 'status_changed'
     AND p_event.actor_type IN ('shop_user', 'admin')
     AND p_event.metadata ->> 'to' IN ('scheduled', 'in_progress', 'completed', 'lost') THEN
    v_kind := 'status_changed';
    v_meta := jsonb_build_object('to', p_event.metadata ->> 'to');
  ELSE
    RETURN NULL;
  END IF;

  INSERT INTO public.notification_events (lead_event_id, lead_id, shop_id, quote_id, kind, actor_id, metadata)
  VALUES (p_event.id, p_event.lead_id, p_event.shop_id, p_event.quote_id, v_kind, p_event.actor_id, v_meta)
  ON CONFLICT (lead_event_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN NULL; -- already queued
  END IF;

  v_email_to := CASE v_kind
    WHEN 'new_request' THEN 'shop'
    WHEN 'customer_message' THEN 'shop'
    WHEN 'shop_reply' THEN 'customer'
  END;

  -- Flood protection for the unauthenticated paths (in-app and push still
  -- record every event): one customer-message email per lead per 10 minutes,
  -- and at most 50 new-request emails per shop per hour.
  IF v_kind = 'customer_message' AND EXISTS (
    SELECT 1
    FROM public.notification_deliveries d
    JOIN public.notification_events e ON e.id = d.event_id
    WHERE e.lead_id = p_event.lead_id
      AND e.kind = 'customer_message'
      AND e.id <> v_event_id
      AND d.channel = 'email'
      AND d.status IN ('pending', 'sending', 'sent')
      AND d.created_at > now() - interval '10 minutes'
  ) THEN
    v_email_to := NULL;
  ELSIF v_kind = 'new_request' AND (
    SELECT count(*)
    FROM public.notification_deliveries d
    JOIN public.notification_events e ON e.id = d.event_id
    WHERE e.shop_id = p_event.shop_id
      AND e.kind = 'new_request'
      AND d.channel = 'email'
      AND d.created_at > now() - interval '1 hour'
  ) >= 50 THEN
    v_email_to := NULL;
  END IF;

  IF v_email_to IS NOT NULL THEN
    INSERT INTO public.notification_deliveries (event_id, channel, recipient_type, recipient_key)
    VALUES (v_event_id, 'email', v_email_to, v_email_to)
    ON CONFLICT DO NOTHING;
  END IF;

  v_staff := v_kind <> 'shop_reply';
  IF v_staff THEN
    INSERT INTO public.notifications (event_id, user_id, shop_id, lead_id, kind, metadata)
    SELECT v_event_id, p.id, p_event.shop_id, p_event.lead_id, v_kind, v_meta
    FROM public.profiles p
    WHERE p.role = 'shop_user'
      AND p.shop_id = p_event.shop_id
      AND p.id IS DISTINCT FROM p_event.actor_id
    ON CONFLICT DO NOTHING;

    INSERT INTO public.notification_deliveries (event_id, channel, recipient_type, recipient_key, user_id, subscription_id)
    SELECT v_event_id, 'push', 'staff', s.id::text, p.id, s.id
    FROM public.profiles p
    JOIN public.push_subscriptions s ON s.user_id = p.id
    WHERE p.role = 'shop_user'
      AND p.shop_id = p_event.shop_id
      AND p.id IS DISTINCT FROM p_event.actor_id
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lead_events_enqueue_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Isolated: a notification failure must never fail the underlying action.
  BEGIN
    PERFORM public.notification_enqueue(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Notification enqueue failed for lead event %: % (%)', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS lead_events_enqueue_notifications ON public.lead_events;
CREATE TRIGGER lead_events_enqueue_notifications
  AFTER INSERT ON public.lead_events
  FOR EACH ROW EXECUTE FUNCTION public.lead_events_enqueue_notifications();

-- ===========================================================================
-- 3. Delivery (service_role only; used by the notification-dispatch function)
-- ===========================================================================

-- Resolves what a delivery should send right now, re-checking authorization.
-- Returns {"skip": reason} when it must not be sent.
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
      ELSE 'Lead updated'
    END;
    v_body := CASE v_event.kind
      WHEN 'new_request' THEN 'A customer submitted a new request.'
      WHEN 'customer_message' THEN 'A customer sent a message about a quote.'
      WHEN 'quote_approved' THEN 'A customer approved a quote.'
      WHEN 'quote_declined' THEN 'A customer declined a quote.'
      WHEN 'date_requested' THEN 'A customer selected a production date.'
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

CREATE OR REPLACE FUNCTION public.claim_notification_deliveries(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_row public.notification_deliveries%ROWTYPE;
  v_payload jsonb;
  v_token uuid;
  v_out jsonb := '[]'::jsonb;
BEGIN
  -- Too late to be useful: abandon instead of notifying about stale events.
  UPDATE public.notification_deliveries d
  SET status = 'failed', lease_token = NULL, leased_until = NULL, updated_at = now(),
      last_error = left('expired: not delivered within 24 hours' || coalesce('; last error: ' || d.last_error, ''), 500)
  WHERE d.created_at < now() - interval '24 hours'
    AND (d.status = 'pending' OR (d.status = 'sending' AND d.leased_until < now()));

  -- A worker died mid-send on its final attempt.
  UPDATE public.notification_deliveries d
  SET status = 'failed', lease_token = NULL, leased_until = NULL, updated_at = now(),
      last_error = coalesce(d.last_error, 'lease expired on final attempt')
  WHERE d.status = 'sending' AND d.leased_until < now() AND d.attempts >= d.max_attempts;

  FOR v_row IN
    SELECT d.*
    FROM public.notification_deliveries d
    WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
       OR (d.status = 'sending' AND d.leased_until < now())
    ORDER BY d.next_attempt_at, d.created_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_payload := public.notification_delivery_payload(v_row);

    IF v_payload ? 'skip' THEN
      UPDATE public.notification_deliveries
      SET status = 'skipped', last_error = v_payload ->> 'skip', lease_token = NULL, leased_until = NULL, updated_at = now()
      WHERE id = v_row.id;
      CONTINUE;
    END IF;

    v_token := gen_random_uuid();
    UPDATE public.notification_deliveries
    SET status = 'sending', attempts = attempts + 1, lease_token = v_token,
        leased_until = now() + interval '2 minutes', updated_at = now()
    WHERE id = v_row.id;

    v_out := v_out || jsonb_build_array(v_payload || jsonb_build_object(
      'delivery_id', v_row.id,
      'lease_token', v_token,
      'channel', v_row.channel,
      'recipient_type', v_row.recipient_type,
      'attempt', v_row.attempts + 1
    ));
  END LOOP;

  RETURN v_out;
END;
$$;

-- p_outcome: sent | retry (transient) | failed (permanent) | gone (push subscription expired)
CREATE OR REPLACE FUNCTION public.complete_notification_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_error text DEFAULT NULL,
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.notification_deliveries%ROWTYPE;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
  v_status text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'failed', 'gone') THEN
    RAISE EXCEPTION 'Invalid delivery outcome' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row
  FROM public.notification_deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  -- Only the worker holding the current lease may record an outcome.
  IF NOT FOUND OR v_row.status <> 'sending' OR v_row.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lease_lost');
  END IF;

  IF p_outcome = 'sent' THEN
    UPDATE public.notification_deliveries
    SET status = 'sent', sent_at = now(), last_error = NULL,
        provider_message_id = left(p_provider_message_id, 200),
        lease_token = NULL, leased_until = NULL, updated_at = now()
    WHERE id = v_row.id;
    IF v_row.subscription_id IS NOT NULL THEN
      UPDATE public.push_subscriptions SET last_success_at = now() WHERE id = v_row.subscription_id;
    END IF;
    v_status := 'sent';
  ELSIF p_outcome = 'gone' THEN
    UPDATE public.notification_deliveries
    SET status = 'skipped', last_error = coalesce(v_error, 'subscription_expired'),
        lease_token = NULL, leased_until = NULL, updated_at = now()
    WHERE id = v_row.id;
    IF v_row.subscription_id IS NOT NULL THEN
      DELETE FROM public.push_subscriptions WHERE id = v_row.subscription_id;
    END IF;
    v_status := 'skipped';
  ELSIF p_outcome = 'retry' AND v_row.attempts < v_row.max_attempts THEN
    UPDATE public.notification_deliveries
    SET status = 'pending', last_error = v_error,
        next_attempt_at = now() + make_interval(mins => power(2, greatest(v_row.attempts - 1, 0))::integer),
        lease_token = NULL, leased_until = NULL, updated_at = now()
    WHERE id = v_row.id;
    v_status := 'pending';
  ELSE
    UPDATE public.notification_deliveries
    SET status = 'failed', last_error = v_error,
        lease_token = NULL, leased_until = NULL, updated_at = now()
    WHERE id = v_row.id;
    v_status := 'failed';
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- ===========================================================================
-- 4. Staff RPCs: own device subscriptions and own inbox only
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role = 'shop_user' AND p.shop_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Only shop staff can enable notifications' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.push_endpoint_is_allowed(p_endpoint) THEN
    RAISE EXCEPTION 'Unsupported push service' USING ERRCODE = 'check_violation';
  END IF;

  -- One row per device endpoint. If another account was signed in on this
  -- browser before, the device now belongs to the current account.
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        last_seen_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Removes one of the caller's own devices, by id or by endpoint.
CREATE OR REPLACE FUNCTION public.delete_push_subscription(p_id uuid DEFAULT NULL, p_endpoint text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.push_subscriptions s
  WHERE s.user_id = v_uid
    AND ((p_id IS NOT NULL AND s.id = p_id) OR (p_endpoint IS NOT NULL AND s.endpoint = p_endpoint));
  RETURN FOUND;
END;
$$;

-- Marks the caller's own notifications read (all of them when p_ids is NULL).
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.notifications n
  SET read_at = now()
  WHERE n.user_id = v_uid
    AND n.read_at IS NULL
    AND (p_ids IS NULL OR n.id = ANY (p_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ===========================================================================
-- 5. RLS
-- ===========================================================================

ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- notification_events / notification_deliveries: no policies (no client access).

DROP POLICY IF EXISTS "push_subscriptions_own_select" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_own_select" ON public.push_subscriptions FOR SELECT
  TO authenticated USING (user_id = auth.uid());

-- Inbox rows are only visible while the user still belongs to that shop.
DROP POLICY IF EXISTS "notifications_own_select" ON public.notifications;
CREATE POLICY "notifications_own_select" ON public.notifications FOR SELECT
  TO authenticated USING (user_id = auth.uid() AND shop_id = public.get_current_shop_id());

-- ===========================================================================
-- 6. Grants
-- ===========================================================================

REVOKE ALL PRIVILEGES ON TABLE public.notification_events FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.notification_deliveries FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.notifications FROM PUBLIC, anon, authenticated;

-- Device keys are never readable by clients, even their own.
GRANT SELECT (id, user_id, endpoint, user_agent, created_at, last_seen_at, last_success_at)
  ON TABLE public.push_subscriptions TO authenticated;
GRANT SELECT ON TABLE public.notifications TO authenticated;

REVOKE ALL ON FUNCTION public.push_endpoint_is_allowed(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_enqueue(public.lead_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_events_enqueue_notifications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_delivery_payload(public.notification_deliveries) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.claim_notification_deliveries(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_notification_delivery(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_deliveries(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_notification_delivery(uuid, uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.register_push_subscription(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_push_subscription(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_subscription(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

COMMIT;
