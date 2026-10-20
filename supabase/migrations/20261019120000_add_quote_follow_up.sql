/*
# Quote follow-ups in the quote conversation

Builds on 20261003230000_add_quote_conversation.sql and the notification
migrations (not edited).

1. A follow-up is a shop/admin message in the existing quote conversation,
   flagged `quote_messages.is_follow_up`. It shares the conversation's history,
   immutability, RLS and customer visibility. The message body stays in the
   conversation; the customer email is only an alert with the quote link.

2. Alerts: inserting the message records the existing `quote_message_added`
   lead event (metadata now also carries `follow_up`), which notification_kind_for
   already maps to `shop_reply`. That queues the existing customer email
   alert exactly once per message (notification_events.lead_event_id is
   unique). No new notification kind, email type or second alert.

3. send_quote_follow_up(quote_id, body, request_id)  -- authenticated (shop/admin)
   - Authorization: admin, or a shop_user of the quote's shop. Shop users
     of a read-only (expired/suspended) shop are refused, matching the
     scheduling rule (schedule_shop_is_read_only).
   - Eligibility: the quote must be sent or viewed, not superseded and not
     expired (same expiry rule as respond_to_quote). Approved, declined and
     draft quotes cannot be followed up, and neither can completed or lost
     leads.
   - Cooldown: at most one follow-up per lead per 24 hours.
   - Locking: the quote row (FOR UPDATE), then the lead row (FOR NO KEY
     UPDATE) -- the same quote-then-lead order as mark_quote_sent,
     respond_to_quote and record_quote_view, whose triggers update the lead
     after the quote. Approval, sending a revision (which supersedes this
     quote) and lead status changes therefore either finish first or wait
     for the follow-up to commit; eligibility is read only after both locks
     are held, so it reflects whatever finished first. The lead lock also
     serializes follow-ups per lead for the cooldown.
   - Duplicates: a retried request with the same request_id returns the
     original message instead of posting again (checked under the locks and
     enforced by a unique index).
   - Never changes the quote (status, pricing, view tracking) or the schedule.
   - Returns the posted message and, separately, whether the customer email
     alert was queued, so the app can report posting and alerting distinctly.
*/

BEGIN;

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

ALTER TABLE public.quote_messages
  ADD COLUMN IF NOT EXISTS is_follow_up boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS follow_up_request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quote_messages_follow_up_shape'
  ) THEN
    ALTER TABLE public.quote_messages
      ADD CONSTRAINT quote_messages_follow_up_shape CHECK (
        (NOT is_follow_up AND follow_up_request_id IS NULL)
        OR (is_follow_up AND sender_type <> 'customer')
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS quote_messages_follow_up_request_key
  ON public.quote_messages(follow_up_request_id) WHERE follow_up_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_messages_lead_follow_ups
  ON public.quote_messages(lead_id, created_at DESC) WHERE is_follow_up;

-- ===========================================================================
-- 2. Audit: mark follow-ups on the existing lead event
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.quote_messages_audit_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_revision integer;
BEGIN
  SELECT q.revision_number INTO v_revision FROM public.quotes q WHERE q.id = NEW.quote_id;
  PERFORM public.record_lead_event(
    NEW.lead_id, NEW.quote_id, 'quote_message_added',
    jsonb_build_object(
      'message_id', NEW.id,
      'sender_type', NEW.sender_type,
      'revision_number', v_revision
    ) || CASE WHEN NEW.is_follow_up THEN jsonb_build_object('follow_up', true) ELSE '{}'::jsonb END
  );
  RETURN NULL;
END;
$$;

-- ===========================================================================
-- 3. Follow-up RPC
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.send_quote_follow_up(p_quote_id uuid, p_body text, p_request_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_shop uuid;
  v_quote public.quotes%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_body text := btrim(coalesce(p_body, ''));
  v_existing public.quote_messages%ROWTYPE;
  v_last timestamptz;
  v_message public.quote_messages%ROWTYPE;
  v_customer_email text;
  v_alert text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.role, p.shop_id INTO v_role, v_shop FROM public.profiles p WHERE p.id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'shop_user') THEN
    RAISE EXCEPTION 'Not allowed to send follow-ups' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote_id;
  IF NOT FOUND OR (v_role = 'shop_user' AND v_quote.shop_id IS DISTINCT FROM v_shop) THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role = 'shop_user' AND public.schedule_shop_is_read_only(v_quote.shop_id) THEN
    RAISE EXCEPTION 'Your account is read-only. Reactivate your subscription to send follow-ups.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Quote, then lead: the lifecycle order (see header). Each lock waits for
  -- any in-flight approval, revision send or status change to commit, and
  -- returns the row as it is afterwards.
  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote_id FOR UPDATE;
  SELECT * INTO v_lead FROM public.leads l WHERE l.id = v_quote.lead_id FOR NO KEY UPDATE;

  -- A retried request returns what it already posted, even if the quote has
  -- since become ineligible.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.quote_messages m WHERE m.follow_up_request_id = p_request_id;
    IF FOUND THEN
      IF v_existing.quote_id IS DISTINCT FROM v_quote.id THEN
        RAISE EXCEPTION 'Follow-up request id already used' USING ERRCODE = 'unique_violation';
      END IF;
      RETURN jsonb_build_object('ok', true, 'duplicate', true,
        'message_id', v_existing.id, 'created_at', v_existing.created_at, 'alert', 'already_handled');
    END IF;
  END IF;

  IF char_length(v_body) NOT BETWEEN 1 AND 5000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_message');
  END IF;

  -- Eligibility, from the locked rows.
  IF v_lead.status IN ('completed', 'lost') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_eligible', 'reason', 'lead_' || v_lead.status);
  END IF;
  IF v_quote.status NOT IN ('sent', 'viewed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_eligible', 'reason', v_quote.status);
  END IF;
  IF v_quote.superseded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_eligible', 'reason', 'superseded');
  END IF;
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < current_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_eligible', 'reason', 'expired');
  END IF;

  SELECT max(m.created_at) INTO v_last
  FROM public.quote_messages m
  WHERE m.lead_id = v_quote.lead_id AND m.is_follow_up;
  IF v_last IS NOT NULL AND v_last > now() - interval '24 hours' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cooldown',
      'last_follow_up_at', v_last, 'next_allowed_at', v_last + interval '24 hours');
  END IF;

  INSERT INTO public.quote_messages (lead_id, quote_id, shop_id, sender_type, sender_id, body, is_follow_up, follow_up_request_id)
  VALUES (v_quote.lead_id, v_quote.id, v_quote.shop_id, v_role, v_uid, v_body, true, p_request_id)
  RETURNING * INTO v_message;

  -- The message is posted at this point. Report the alert separately: the
  -- notification trigger never blocks the message, so it may not have queued.
  v_customer_email := btrim(coalesce(v_lead.customer_email, ''));
  IF EXISTS (
    SELECT 1
    FROM public.lead_events le
    JOIN public.notification_events ne ON ne.lead_event_id = le.id
    JOIN public.notification_deliveries d ON d.event_id = ne.id
    WHERE le.lead_id = v_quote.lead_id
      AND le.event_type = 'quote_message_added'
      AND le.metadata ->> 'message_id' = v_message.id::text
      AND d.channel = 'email'
      AND d.recipient_type = 'customer'
  ) THEN
    v_alert := CASE WHEN v_customer_email ~ '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$' THEN 'queued' ELSE 'no_customer_email' END;
  ELSE
    v_alert := 'not_queued';
  END IF;

  RETURN jsonb_build_object('ok', true, 'duplicate', false,
    'message_id', v_message.id, 'created_at', v_message.created_at, 'alert', v_alert);
END;
$$;

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

REVOKE ALL ON FUNCTION public.send_quote_follow_up(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_quote_follow_up(uuid, text, uuid) TO authenticated;

-- CREATE OR REPLACE keeps existing privileges; restated for clarity.
REVOKE ALL ON FUNCTION public.quote_messages_audit_insert() FROM PUBLIC, anon, authenticated;

COMMIT;
