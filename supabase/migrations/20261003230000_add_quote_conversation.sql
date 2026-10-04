/*
# Quote conversation workflow

Builds on 20261003200000_lead_lifecycle_phase_1.sql (already applied; not edited).

1. New table `quote_messages`
   - One immutable row per message, attached to the quote revision that was
     current when it was written. Newer revisions show earlier revisions'
     messages; an older revision's link never shows messages from later ones.
   - sender_type: customer | shop_user | admin. sender_id is NULL for customers
     and the staff user's id otherwise.
   - Body is trimmed and limited to 1-5000 characters.

2. RPCs
   - send_public_quote_message(token, body)  -- anon, authenticated (customer)
   - get_public_quote_messages(token)        -- anon, authenticated (customer)
   - send_shop_quote_message(quote_id, body) -- authenticated (shop/admin)

3. respond_to_quote(token, response) now accepts only 'approve'. The 'declined'
   quote status remains valid in the schema and historical declined quotes are
   untouched; customers simply cannot create new declines.

4. Audit: every message records a `quote_message_added` lead event with
   structural metadata only (never the message body).

5. Security
   - RLS on quote_messages: admins read all, shop users read their own shop.
   - No INSERT/UPDATE/DELETE grants for anon or authenticated; writes only via
     the SECURITY DEFINER RPCs above (fixed `search_path = ''`).
   - UPDATE is always rejected; direct DELETE is rejected unless it is a
     cascade from deleting the parent lead/quote/shop.
*/

BEGIN;

-- ===========================================================================
-- 1. Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.quote_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'shop_user', 'admin')),
  sender_id uuid,
  body text NOT NULL CHECK (body = btrim(body) AND char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_messages_sender_identity CHECK ((sender_type = 'customer') = (sender_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_quote_messages_lead_created ON public.quote_messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quote_messages_quote_created ON public.quote_messages(quote_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quote_messages_shop_id ON public.quote_messages(shop_id);

-- ===========================================================================
-- 2. Immutability + audit triggers
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.quote_messages_prevent_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Foreign-key cascades run inside the referential-integrity trigger, so they
  -- arrive here nested (depth > 1). A direct DELETE arrives at depth 1.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Quote messages are immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS quote_messages_prevent_change ON public.quote_messages;
CREATE TRIGGER quote_messages_prevent_change
  BEFORE UPDATE OR DELETE ON public.quote_messages
  FOR EACH ROW EXECUTE FUNCTION public.quote_messages_prevent_change();

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
    )
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS quote_messages_audit_insert ON public.quote_messages;
CREATE TRIGGER quote_messages_audit_insert
  AFTER INSERT ON public.quote_messages
  FOR EACH ROW EXECUTE FUNCTION public.quote_messages_audit_insert();

-- ===========================================================================
-- 3. Customer RPCs (token-scoped)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.send_public_quote_message(p_token uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
  v_body text := btrim(coalesce(p_body, ''));
  v_message_id uuid;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 5000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_message');
  END IF;

  SELECT * INTO v_quote
  FROM public.quotes q
  WHERE q.public_token = p_token AND q.status <> 'draft';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF public.quote_viewer_is_staff(v_quote.shop_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_preview');
  END IF;
  IF v_quote.superseded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'superseded');
  END IF;

  -- Basic abuse guard for this unauthenticated write path.
  IF (
    SELECT count(*) FROM public.quote_messages m
    WHERE m.quote_id = v_quote.id
      AND m.sender_type = 'customer'
      AND m.created_at > now() - interval '10 minutes'
  ) >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  PERFORM set_config('specplus.actor_type', 'customer', true);
  PERFORM set_config('specplus.actor_id', '', true);

  INSERT INTO public.quote_messages (lead_id, quote_id, shop_id, sender_type, sender_id, body)
  VALUES (v_quote.lead_id, v_quote.id, v_quote.shop_id, 'customer', NULL, v_body)
  RETURNING id INTO v_message_id;

  RETURN jsonb_build_object('ok', true, 'message_id', v_message_id);
END;
$$;

-- Messages visible from a token: same lead, revisions up to and including the
-- token's revision. Customer-safe fields only (no sender_id / shop_id).
CREATE OR REPLACE FUNCTION public.get_public_quote_messages(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT * INTO v_quote
  FROM public.quotes q
  WHERE q.public_token = p_token AND q.status <> 'draft';

  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id,
      'quote_id', m.quote_id,
      'revision_number', mq.revision_number,
      'sender_type', m.sender_type,
      'body', m.body,
      'created_at', m.created_at
    ) ORDER BY m.created_at, m.id)
    FROM public.quote_messages m
    JOIN public.quotes mq ON mq.id = m.quote_id
    WHERE m.lead_id = v_quote.lead_id
      AND mq.lead_id = v_quote.lead_id
      AND mq.revision_number <= v_quote.revision_number
  ), '[]'::jsonb);
END;
$$;

-- ===========================================================================
-- 4. Shop/admin reply RPC
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.send_shop_quote_message(p_quote_id uuid, p_body text)
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
  v_body text := btrim(coalesce(p_body, ''));
  v_message_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.role, p.shop_id INTO v_role, v_shop FROM public.profiles p WHERE p.id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'shop_user') THEN
    RAISE EXCEPTION 'Not allowed to send messages' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote_id;
  IF NOT FOUND OR (v_role = 'shop_user' AND v_quote.shop_id IS DISTINCT FROM v_shop) THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_quote.status = 'draft' THEN
    RAISE EXCEPTION 'Send the quote before messaging the customer' USING ERRCODE = 'check_violation';
  END IF;
  IF v_quote.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'This quote has been revised; reply on the current quote' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Message must be between 1 and 5000 characters' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.quote_messages (lead_id, quote_id, shop_id, sender_type, sender_id, body)
  VALUES (v_quote.lead_id, v_quote.id, v_quote.shop_id, v_role, v_uid, v_body)
  RETURNING id INTO v_message_id;

  RETURN jsonb_build_object('ok', true, 'message_id', v_message_id);
END;
$$;

-- ===========================================================================
-- 5. respond_to_quote: approval only
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.respond_to_quote(p_token uuid, p_response text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quotes%ROWTYPE;
BEGIN
  -- Customers can only approve. Questions and change requests go through the
  -- quote conversation instead of a decline.
  IF p_response IS NULL OR p_response <> 'approve' THEN
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

  UPDATE public.quotes
  SET status = 'approved',
      approved_at = now()
  WHERE id = v_quote.id;

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'responded_at', now());
END;
$$;

-- ===========================================================================
-- 6. RLS
-- ===========================================================================

ALTER TABLE public.quote_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_messages_admin_select" ON public.quote_messages;
CREATE POLICY "quote_messages_admin_select" ON public.quote_messages FOR SELECT
  TO authenticated USING (public.get_current_role() = 'admin');

DROP POLICY IF EXISTS "quote_messages_shop_select" ON public.quote_messages;
CREATE POLICY "quote_messages_shop_select" ON public.quote_messages FOR SELECT
  TO authenticated USING (shop_id = public.get_current_shop_id());

-- ===========================================================================
-- 7. Grants
-- ===========================================================================

REVOKE ALL PRIVILEGES ON TABLE public.quote_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.quote_messages TO authenticated;

REVOKE ALL ON FUNCTION public.quote_messages_prevent_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quote_messages_audit_insert() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.send_public_quote_message(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_quote_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_public_quote_message(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_quote_messages(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.send_shop_quote_message(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_shop_quote_message(uuid, text) TO authenticated;

-- CREATE OR REPLACE keeps existing privileges; restated for clarity.
REVOKE ALL ON FUNCTION public.respond_to_quote(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_to_quote(uuid, text) TO anon, authenticated;

COMMIT;
