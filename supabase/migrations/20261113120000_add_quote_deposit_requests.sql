/*
# Deposit requests set on each quote

Builds on 20261111120000_add_instant_booking_and_deposits.sql (already
applied; not edited). Additive only: no table or data is dropped.

What changes
  - The deposit request is part of completing a quote. Each quote row carries
    its own request: deposit_requested (off by default, including for every
    existing quote), a payment/invoice link for this quote, an optional
    amount and customer instructions. They are saved with the draft (the same
    UPDATE as the rest of the draft, so it saves or fails as one) and are
    locked once the quote is sent, like its pricing. Revisions are new rows,
    so revising never rewrites the deposit terms of a sent quote.
  - When requested, a safe https payment link is required. The guard trigger
    validates it on every write (deposit_clean_details: https, a hostname, no
    credentials, spaces or control characters), so an invalid link can't be
    saved, and a quote with a requested deposit and no valid link can't be
    marked sent. The send-quote Edge Function checks the stored quote again
    before any email is sent.
  - When a customer books (book_schedule_date -> deposit_snapshot_for_booking),
    the lead's deposit is copied from the quote that was booked (the current,
    approved revision), source 'quote', with its quote_id. There is no
    fallback to the shop-wide defaults: a quote with the deposit off books
    with no deposit request and no payment button.
  - Precedence at booking (deposit_snapshot_for_booking), in order:
      1. A lead deposit attached to a booking (lead_deposits.attached_at,
         set when a booking takes it or when staff edit it while a booking
         is active), a received deposit, or any deposit when the lead has
         been booked before: kept as is, never rewritten by a booking or a
         revision. Receipt history and the received-amount lock are
         unchanged (set_lead_deposit is not modified).
      2. First booking, with an unattached lead setting saved AFTER the
         booked quote was sent: an intentional correction for this quote;
         it is kept and attached.
      3. Otherwise the booked quote's explicit choice applies: deposit on
         copies its link, amount and instructions; deposit off means no
         deposit request. An older, unbooked, unreceived lead setting (from
         before the quote was sent) is replaced by that choice.
    Existing rows are backfilled as attached when they came from a booking
    (shop defaults), were received, or belong to a lead that has had a
    booking, so nothing already on TEST changes meaning.
  - Staff can still correct an outstanding link or request a deposit later
    on the lead after booking; those rows are attached and kept.
  - The snapshot still runs in its own subtransaction: a problem is logged
    and skipped and never undoes or blocks the booking.
  - Shop-wide deposit defaults are retired: set_shop_deposit_settings is no
    longer executable by clients and bookings no longer read
    shop_deposit_settings. The table and its rows are kept (unused).

Security: the new quote columns follow the quotes table's existing column
grants and RLS (shop staff on their own shop's drafts; admins). The guard
trigger is SECURITY DEFINER only so it can call the internal validators; it
reads nothing but the row being written.
*/

-- ===========================================================================
-- 1. Quote columns
-- ===========================================================================

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS deposit_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_payment_url text,
  ADD COLUMN IF NOT EXISTS deposit_amount numeric(10, 2),
  ADD COLUMN IF NOT EXISTS deposit_instructions text;

ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_deposit_details_check;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_deposit_details_check CHECK (
  (deposit_payment_url IS NULL OR deposit_payment_url LIKE 'https://%')
  AND (deposit_amount IS NULL OR deposit_amount BETWEEN 0.01 AND 1000000)
  AND (deposit_instructions IS NULL OR char_length(deposit_instructions) BETWEEN 1 AND 1000)
  -- Off means no details; on needs this quote's payment link.
  AND (deposit_requested OR (deposit_payment_url IS NULL AND deposit_amount IS NULL AND deposit_instructions IS NULL))
  AND (NOT deposit_requested OR deposit_payment_url IS NOT NULL)
);

GRANT INSERT (deposit_requested, deposit_payment_url, deposit_amount, deposit_instructions) ON TABLE public.quotes TO authenticated;
GRANT UPDATE (deposit_requested, deposit_payment_url, deposit_amount, deposit_instructions) ON TABLE public.quotes TO authenticated;

-- Validates and normalizes the deposit fields on every write, and keeps them
-- unchanged once the quote has left draft.
CREATE OR REPLACE FUNCTION public.quotes_deposit_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_clean record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF (NEW.deposit_requested, NEW.deposit_payment_url, NEW.deposit_amount, NEW.deposit_instructions)
       IS DISTINCT FROM (OLD.deposit_requested, OLD.deposit_payment_url, OLD.deposit_amount, OLD.deposit_instructions) THEN
      RAISE EXCEPTION 'A sent quote cannot be changed; create a revision instead' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW.deposit_requested := coalesce(NEW.deposit_requested, false);
  IF NOT NEW.deposit_requested THEN
    NEW.deposit_payment_url := NULL;
    NEW.deposit_amount := NULL;
    NEW.deposit_instructions := NULL;
    RETURN NEW;
  END IF;

  SELECT * INTO v_clean FROM public.deposit_clean_details(NEW.deposit_payment_url, NEW.deposit_amount, NEW.deposit_instructions);
  IF v_clean.payment_url IS NULL THEN
    RAISE EXCEPTION 'Add this quote''s payment link (https://) or turn off the deposit request.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.deposit_payment_url := v_clean.payment_url;
  NEW.deposit_amount := v_clean.amount;
  NEW.deposit_instructions := v_clean.instructions;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotes_deposit_guard ON public.quotes;
CREATE TRIGGER quotes_deposit_guard
  BEFORE INSERT OR UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_deposit_guard();

REVOKE ALL ON FUNCTION public.quotes_deposit_guard() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 2. Lead deposits copied from the booked quote
-- ===========================================================================

ALTER TABLE public.lead_deposits
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL;

ALTER TABLE public.lead_deposits DROP CONSTRAINT IF EXISTS lead_deposits_source_check;
ALTER TABLE public.lead_deposits ADD CONSTRAINT lead_deposits_source_check
  CHECK (source IN ('shop_default', 'staff', 'quote'));

-- Whether a lead's deposit is tied to a booking (taken by one, or edited by
-- staff while one is active). Attached deposits are never replaced by a
-- later booking or revision.
ALTER TABLE public.lead_deposits
  ADD COLUMN IF NOT EXISTS attached_at timestamptz;

-- Existing rows keep their meaning: anything that came from a booking, was
-- received, or belongs to a lead that has had a booking stays as is.
UPDATE public.lead_deposits d SET attached_at = d.created_at
WHERE d.attached_at IS NULL
  AND (d.source = 'shop_default' OR d.received_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.schedule_reservations r WHERE r.lead_id = d.lead_id));

-- Staff edits while a booking is active (correcting an outstanding link,
-- requesting a deposit later) attach the deposit to that booking.
CREATE OR REPLACE FUNCTION public.lead_deposits_attach()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.attached_at IS NOT NULL THEN
    NEW.attached_at := OLD.attached_at; -- never detached
  ELSIF NEW.attached_at IS NULL AND EXISTS (
    SELECT 1 FROM public.schedule_reservations r WHERE r.lead_id = NEW.lead_id AND r.status = 'active'
  ) THEN
    NEW.attached_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lead_deposits_attach ON public.lead_deposits;
CREATE TRIGGER lead_deposits_attach
  BEFORE INSERT OR UPDATE ON public.lead_deposits
  FOR EACH ROW EXECUTE FUNCTION public.lead_deposits_attach();

REVOKE ALL ON FUNCTION public.lead_deposits_attach() FROM PUBLIC, anon, authenticated;

-- Decides the deposit for a booking that was just created (the reservation
-- row already exists). Precedence (see the header):
--   1. attached, received, or not the lead's first booking: keep the row;
--   2. first booking, lead setting saved after the booked quote was sent:
--      keep it (an intentional correction) and attach it;
--   3. otherwise the booked quote's explicit choice, replacing any older,
--      unbooked, unreceived lead setting.
-- No shop-wide fallback. Never raises: a problem is logged and the booking
-- goes ahead without changing the deposit.
CREATE OR REPLACE FUNCTION public.deposit_snapshot_for_booking(p_lead_id uuid, p_shop_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.lead_deposits%ROWTYPE;
  v_has_row boolean;
  v_first_booking boolean;
  v_quote public.quotes%ROWTYPE;
  v_quote_ok boolean;
  v_requested boolean := false;
BEGIN
  BEGIN
    SELECT * INTO v_row FROM public.lead_deposits d WHERE d.lead_id = p_lead_id FOR UPDATE;
    v_has_row := FOUND;
    v_first_booking := (SELECT count(*) FROM public.schedule_reservations r WHERE r.lead_id = p_lead_id) <= 1;

    IF v_has_row AND (v_row.attached_at IS NOT NULL OR v_row.received_at IS NOT NULL OR NOT v_first_booking) THEN
      RETURN v_row.requested;
    END IF;

    v_quote := public.schedule_current_quote(p_lead_id);
    v_quote_ok := v_quote.id IS NOT NULL AND v_quote.status = 'approved' AND v_quote.shop_id = p_shop_id;

    IF v_has_row AND (NOT v_quote_ok OR v_quote.sent_at IS NULL OR v_row.updated_at > v_quote.sent_at) THEN
      UPDATE public.lead_deposits SET attached_at = now() WHERE lead_id = p_lead_id;
      RETURN v_row.requested;
    END IF;

    v_requested := v_quote_ok AND v_quote.deposit_requested AND public.deposit_url_is_safe(v_quote.deposit_payment_url);
    IF v_has_row THEN
      UPDATE public.lead_deposits SET requested = v_requested,
        payment_url = CASE WHEN v_requested THEN v_quote.deposit_payment_url END,
        amount = CASE WHEN v_requested THEN v_quote.deposit_amount END,
        instructions = CASE WHEN v_requested THEN v_quote.deposit_instructions END,
        source = 'quote', quote_id = v_quote.id, attached_at = now(), updated_by = NULL, updated_at = now()
      WHERE lead_id = p_lead_id;
    ELSIF v_requested THEN
      INSERT INTO public.lead_deposits (lead_id, shop_id, requested, payment_url, amount, instructions, source, quote_id, attached_at)
      VALUES (p_lead_id, p_shop_id, true, v_quote.deposit_payment_url, v_quote.deposit_amount, v_quote.deposit_instructions,
        'quote', v_quote.id, now());
    END IF;
    RETURN v_requested;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Deposit snapshot skipped for lead %: % (%)', p_lead_id, SQLERRM, SQLSTATE;
    RETURN coalesce((SELECT d.requested FROM public.lead_deposits d WHERE d.lead_id = p_lead_id), false);
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.deposit_snapshot_for_booking(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 3. Shop-wide deposit defaults retired
-- ===========================================================================

REVOKE ALL ON FUNCTION public.set_shop_deposit_settings(uuid, boolean, text, numeric, text) FROM PUBLIC, anon, authenticated;
