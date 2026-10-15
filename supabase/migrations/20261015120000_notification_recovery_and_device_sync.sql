/*
# Notifications: lost-event recovery, device sync, lease-safe release

Builds on 20261014120000_add_notifications.sql (not edited, so this applies
cleanly whether or not that migration is already installed somewhere).

1. Recovery of events whose enqueue failed
   - The lead_events trigger deliberately swallows notification errors so the
     customer's action always succeeds. The audit row is kept, so the work can
     be rebuilt: recover_notification_events (service_role, called by
     notification-dispatch every run) re-enqueues eligible lead_events that
     have no notification_events row.
   - Bounded: only events at or after the persisted activation boundary
     (notification_settings.activated_at, set once when this migration is
     first applied and never moved by a re-run) and from the last 24 hours,
     at most p_limit (≤ 500) per call, each in its own exception block.
   - Idempotent: notification_events.lead_event_id is unique and enqueue uses
     ON CONFLICT DO NOTHING, so concurrent or repeated recovery never
     duplicates anything. Historical events (before activation) are never
     notified.
   - Eligibility lives in one function, notification_kind_for, used by both
     the trigger path and recovery.

2. Device sync without resurrection
   - touch_push_subscription only refreshes an existing row owned by the
     caller; it never creates one. The app calls it on load/login, so a device
     removed remotely (or expired) stays removed until someone explicitly taps
     Enable notifications on it (register_push_subscription).

3. Lease-safe early stop
   - complete_notification_delivery accepts outcome 'release': a worker that
     runs out of time hands an unsent, still-leased delivery back immediately
     (pending, attempt not counted) instead of holding it until the lease
     expires.
*/

BEGIN;

-- ===========================================================================
-- 1. Activation boundary
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.notification_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  activated_at timestamptz NOT NULL DEFAULT now()
);

-- First application only: re-running must not move the boundary.
INSERT INTO public.notification_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.notification_settings FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_lead_events_created_at ON public.lead_events(created_at);

-- ===========================================================================
-- 2. Eligibility (single source for trigger and recovery)
-- ===========================================================================

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
    WHEN p_event.event_type = 'status_changed'
      AND p_event.actor_type IN ('shop_user', 'admin')
      AND p_event.metadata ->> 'to' IN ('scheduled', 'in_progress', 'completed', 'lost')
      THEN 'status_changed'
  END;
$$;

CREATE OR REPLACE FUNCTION public.notification_enqueue(p_event public.lead_events)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text := public.notification_kind_for(p_event);
  v_meta jsonb := '{}'::jsonb;
  v_event_id uuid;
  v_email_to text;
BEGIN
  IF v_kind IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_kind = 'status_changed' THEN
    v_meta := jsonb_build_object('to', p_event.metadata ->> 'to');
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

  IF v_kind <> 'shop_reply' THEN
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

-- ===========================================================================
-- 3. Recovery (service_role only)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.recover_notification_events(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_since timestamptz;
  v_event public.lead_events%ROWTYPE;
  v_recovered integer := 0;
  v_failed integer := 0;
BEGIN
  SELECT greatest(s.activated_at, now() - interval '24 hours') INTO v_since
  FROM public.notification_settings s
  WHERE s.id;
  IF v_since IS NULL THEN
    RETURN jsonb_build_object('recovered', 0, 'failed', 0);
  END IF;

  FOR v_event IN
    SELECT e.*
    FROM public.lead_events e
    WHERE e.created_at >= v_since
      AND public.notification_kind_for(e) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.notification_events n WHERE n.lead_event_id = e.id)
    ORDER BY e.created_at, e.id
    LIMIT v_limit
  LOOP
    BEGIN
      IF public.notification_enqueue(v_event) IS NOT NULL THEN
        v_recovered := v_recovered + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'Notification recovery failed for lead event %: % (%)', v_event.id, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  RETURN jsonb_build_object('recovered', v_recovered, 'failed', v_failed);
END;
$$;

-- ===========================================================================
-- 4. Delivery completion: adds 'release'
-- ===========================================================================

-- p_outcome: sent | retry (transient) | failed (permanent) |
--            gone (push subscription expired) | release (not attempted; hand back)
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
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'failed', 'gone', 'release') THEN
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
  ELSIF p_outcome = 'release' THEN
    -- Never sent this time, so the attempt is not counted.
    UPDATE public.notification_deliveries
    SET status = 'pending', attempts = greatest(v_row.attempts - 1, 0), next_attempt_at = now(),
        lease_token = NULL, leased_until = NULL, updated_at = now()
    WHERE id = v_row.id;
    v_status := 'pending';
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
-- 5. Device sync: refresh only, never (re)create
-- ===========================================================================

-- Returns 'active' when the caller still owns this device's subscription,
-- 'missing' when it was removed (remotely, by sign-out or by expiry), or
-- 'other_user' when another account enabled this browser since.
CREATE OR REPLACE FUNCTION public.touch_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.user_id INTO v_owner FROM public.push_subscriptions s WHERE s.endpoint = p_endpoint;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF v_owner <> v_uid THEN
    RETURN 'other_user';
  END IF;

  UPDATE public.push_subscriptions
  SET p256dh = p_p256dh, auth = p_auth, last_seen_at = now()
  WHERE endpoint = p_endpoint AND user_id = v_uid;
  RETURN 'active';
END;
$$;

-- ===========================================================================
-- 6. Grants
-- ===========================================================================

REVOKE ALL ON FUNCTION public.notification_kind_for(public.lead_events) FROM PUBLIC, anon, authenticated;
-- CREATE OR REPLACE keeps existing privileges; restated for clarity.
REVOKE ALL ON FUNCTION public.notification_enqueue(public.lead_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_notification_delivery(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_notification_delivery(uuid, uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.recover_notification_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_notification_events(integer) TO service_role;

REVOKE ALL ON FUNCTION public.touch_push_subscription(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_push_subscription(text, text, text) TO authenticated;

COMMIT;
