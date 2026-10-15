# Notifications: email, staff Web Push and in-app bell

One pipeline feeds every channel. Nothing on this branch has been deployed or
applied to any hosted database by this work; everything below marked as a step
is manual.

## How it works

```
customer / staff action ──► lead_events (existing audit trail, same transaction)
                               │ AFTER INSERT trigger (exception-isolated)
                               │   └─ if it fails: the action still succeeds and
                               │      the dispatcher's recovery step rebuilds it
                               ▼
                         notification_events ──► notifications (in-app bell, per staff user)
                               │
                               ▼
                    notification_deliveries (one row per channel × recipient)
                               │ claim (2-minute lease + authorization re-check)
                               ▼
              notification-dispatch Edge Function (every minute, via pg_cron)
                 0. recover_notification_events (bounded, idempotent)
                 ├─ email → Resend (Idempotency-Key per delivery, 10 s timeout)
                 └─ push  → browser push service (VAPID, aes128gcm, 10 s timeout)
                               │ complete (sent / retry / failed / gone / release)
                               ▼
                    outcome, attempts, last error recorded per delivery
```

| Event | Shop email | Customer email | Staff push + bell |
|---|---|---|---|
| New request (custom or preconfigured) | ✓ link to CRM lead | | ✓ |
| Customer quote message | ✓ link to CRM lead | | ✓ |
| Shop/admin quote reply | | ✓ link to the customer's current quote | |
| Quote approved / declined | | | ✓ |
| Customer selected a production date | | | ✓ |
| Staff moved a lead to Scheduled / In Progress / Completed / Lost | | | ✓ (other staff) |

- **Recipients** are resolved in the database: shop email = `shops.contact_email`;
  staff = `shop_user` profiles of the lead's shop (admins are not recipients);
  the staff member who performed an action is never notified about it.
- **Authorization is re-checked at delivery**: shop membership, device ownership,
  current contact email, current customer quote link. Failing checks are
  recorded as `skipped` with a reason.
- **Retries**: transient failures back off 1, 2, 4, 8 minutes, max 5 attempts;
  anything undelivered 24 hours after it was queued is abandoned (`failed`,
  "expired"). Expired push subscriptions (HTTP 404/410) are deleted.
- **Isolation and recovery**: a notification failure is logged as a warning and
  never fails or rolls back the submission, message, approval or date request.
  Because the audit event is kept, each dispatcher run re-enqueues eligible
  events that have no notification yet (`recover_notification_events`):
  at most 100 per run, only events from the last 24 hours **and** at or after
  the persisted activation boundary (`notification_settings.activated_at`, set
  when the recovery migration is first applied). Re-running is harmless: one
  notification event per audit event is enforced by a unique constraint.
- **History**: events before activation are never notified, by the trigger or
  by recovery.
- **Flood protection**: at most one customer-message email per lead per 10
  minutes and 50 new-request emails per shop per hour (bell and push still
  record everything).
- **Privacy**: lock-screen text is generic ("New request", "A customer sent a
  message about a quote") — no names, vehicles or message bodies. Emails never
  include message bodies; recipients follow the link. Push payloads are
  end-to-end encrypted. The service worker (`/push-sw.js`) has no fetch handler
  and caches nothing. The old caching `/sw.js` is replaced by a version that
  clears its caches and unregisters itself.

### Delivery guarantees (at least once, not exactly once)

Notifications are delivered **at least once** while retries last; the design
keeps duplicates rare but does not guarantee exactly-once delivery:

- **Queueing** is exactly once per audit event per recipient (unique
  constraints), including under concurrent recovery runs.
- **Leases**: a delivery is claimed by one worker at a time for 2 minutes, and
  only the lease holder can record its outcome. Every provider request is
  aborted after 10 seconds; before **each** delivery the dispatcher checks that
  a full request plus a safety margin still fits inside both its run budget
  (45 s) and that batch's lease, and otherwise hands the remaining deliveries
  back unsent (`release`, attempt not counted). So no provider request is ever
  still in flight when its lease can expire and another worker takes over.
- **Email**: a timed-out or unrecorded send is retried with the same Resend
  `Idempotency-Key`, which Resend de-duplicates for 24 hours.
- **Push has no provider-side idempotency.** If a push service accepted a
  request but the response was lost or timed out, or the outcome could not be
  recorded, the retry can deliver it again. Mitigations: the `Topic` header
  replaces a still-queued copy at the push service, and the notification `tag`
  (the event id) makes a device replace the earlier copy rather than stack a
  second one. Staff may still occasionally see a repeated alert.

### Devices

- **Enable notifications** (an explicit tap) is the only way a device is
  registered.
- On each page load/login the app only *refreshes* an existing registration
  (`touch_push_subscription`). If the device was removed — from "Your devices"
  on another device, by signing out, or by the server after it expired — or now
  belongs to another account, the app drops the browser subscription and shows
  **Off**. It stays off until someone taps **Enable notifications** on that
  device again.

## Environments: test first

**Previews.** Codex configured this branch's **future** Vercel preview builds to
use the isolated test Supabase project. The existing preview deployment was
**not rebuilt** and still points at the production database (`brzgvpissnewfkhblpvs`):
do not use it to test notifications. Only test on a preview built after that
configuration change, and confirm in the browser's network tab that its
Supabase URL is the test project before submitting anything.

**Test project setup (do this before any production step):**

1. Apply both migrations to the **test** project only:
   `20261014120000_add_notifications.sql`, then
   `20261015120000_notification_recovery_and_device_sync.sql`.
2. Generate a **separate test VAPID key pair** (never reuse production keys) and
   a separate dispatch secret.
3. Set the Edge Function secrets below on the **test** project, with
   `CRM_ORIGIN` / `PUBLIC_QUOTE_ORIGIN` pointing at the test preview URL so
   links stay in the test environment. Deploy `notification-dispatch` there.
4. Test data only: a test shop whose contact email is an inbox you control (or
   Resend's test address `delivered@resend.dev`), test customers with
   addresses you control. Never use real shop or customer data.
5. Set `VITE_VAPID_PUBLIC_KEY` (the test public key) for the **preview**
   environment in Vercel and rebuild the preview.
6. Schedule the dispatcher on the test project (step 4 of the production
   steps, with the test project URL), run the acceptance checks below, and
   check the monitoring queries.

Only after the test project passes, repeat the steps for production.

## Required infrastructure and secrets

No paid services are needed: Resend is already in use, Web Push uses the
browsers' free push services, and `pg_cron`, `pg_net` and Vault are included
Supabase extensions. Use different values per environment.

| Where | Name | Purpose |
|---|---|---|
| Edge Function secret | `RESEND_API_KEY` | Existing Resend key (already set for send-quote) |
| Edge Function secret | `RESEND_FROM_EMAIL` / `NOTIFICATION_FROM_EMAIL` (optional) | Sender address on the verified Resend domain; defaults to `quotes@specplus.app` |
| Edge Function secret | `NOTIFICATION_DISPATCH_SECRET` | Random string, at least 32 characters; only the scheduler knows it |
| Edge Function secret | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair (base64url, generated once per environment) |
| Edge Function secret | `VAPID_SUBJECT` | Contact for push services, e.g. `mailto:` an operations address |
| Edge Function secret | `CRM_ORIGIN` (optional) | Link base for shop emails; defaults to `https://crm.specplus.app` |
| Edge Function secret | `PUBLIC_QUOTE_ORIGIN` (optional) | Link base for customer emails; defaults to `https://quotes.specplus.app` |
| Edge Function secret | `NOTIFICATION_REQUEST_TIMEOUT_MS`, `NOTIFICATION_RUN_BUDGET_MS` (optional) | Lower the 10 s provider timeout / 45 s run budget; values above those maxima are ignored |
| Vercel env (build-time) | `VITE_VAPID_PUBLIC_KEY` | Same value as that environment's `VAPID_PUBLIC_KEY` (public, not secret). Without it the app shows "not configured" and only email + bell work |
| Supabase Vault | `notification_dispatch_secret` | Same value as `NOTIFICATION_DISPATCH_SECRET`, read by the cron job |

Generate a VAPID key pair locally (prints values; store them only in the
secret managers above, never in the repository):

```sh
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});const b=s=>Buffer.from(s,'base64url');console.log('VAPID_PUBLIC_KEY='+Buffer.concat([Buffer.from([4]),b(k.x),b(k.y)]).toString('base64url'));console.log('VAPID_PRIVATE_KEY='+k.d)"
```

Rotating the VAPID keys invalidates every existing device subscription. Each
device then shows notifications as **Off**; tapping **Enable notifications**
replaces the old subscription (and removes its server record). Until then,
pushes to old subscriptions are recorded as `failed` (HTTP 401/403).

## Production deployment steps (not performed)

Only after the test project checks pass. Once the migrations and scheduler are
live in production, real shops and customers receive real notifications.

1. Apply `20261014120000_add_notifications.sql`, then
   `20261015120000_notification_recovery_and_device_sync.sql`. The activation
   boundary is set when the second one is applied.
2. Set the production Edge Function secrets, then deploy `notification-dispatch`
   (config.toml sets `verify_jwt = false`; the function requires the secret
   header instead and accepts no recipients or content).
3. Set the production `VITE_VAPID_PUBLIC_KEY` in Vercel and redeploy the frontend.
4. Store the dispatch secret in Vault and schedule the dispatcher (replace the
   placeholders; do not commit the value):

   ```sql
   select vault.create_secret('<NOTIFICATION_DISPATCH_SECRET value>', 'notification_dispatch_secret');

   select cron.schedule('notification-dispatch', '* * * * *', $$
     select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/notification-dispatch',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-notification-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notification_dispatch_secret')
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     );
   $$);
   ```

   Until this runs, events are queued (and shown in the bell) but no email or
   push is sent. Queued work older than 24 hours is abandoned, not sent late.
   Overlapping runs are safe (leases), so a slow run does not need to finish
   before the next minute starts.

5. Monitor:
   - `select channel, status, last_error, count(*) from notification_deliveries group by 1, 2, 3;`
   - Function logs: each run returns `recovered`, `claimed`, `sent`, `retry`,
     `failed`, `gone`, `released`, `lease_lost`. A non-zero `recovered` means
     enqueue failed at some point; look for "Notification enqueue failed"
     warnings in the database logs.

## Real-device acceptance checks

Run these on the **test** project first (see above). Use a test shop with a
test contact email, a test customer email you control, and two staff accounts
(A and B) in that shop.

### iPhone (iOS 16.4 or later)
1. In Safari, open the CRM and sign in as A → Notifications. Status shows
   **Install first** with the Home Screen steps.
2. Share → Add to Home Screen; open SpecPlus from the Home Screen; sign in.
3. Notifications → **Enable notifications** → Allow. Status shows **On**; the
   device appears under "Your devices" as "iPhone · Safari" / "This device".
4. Lock the phone. As a customer (private window on another device), submit a
   **preconfigured** request, then a **custom** request. Within ~1 minute the
   lock screen shows "New request" / "A customer submitted a new request." with
   no customer name or vehicle.
5. Tap the notification: the lead opens. Repeat after signing out of the app's
   session (or letting it expire): tapping shows sign-in, then the lead.
6. Customer sends a quote message → "New customer message" push; the shop
   contact inbox gets an email whose button opens the CRM lead.
7. Customer approves the quote → "Quote approved". Customer selects an offered
   production date → "Production date selected".
8. As A, move a lead to In Progress: A gets nothing; B (on another device) gets
   "Lead updated".
9. As A, reply to the customer on the quote: the customer inbox gets
   "<Shop> replied about your … quote" whose button opens the customer quote
   page (not the CRM); A's phone gets no push.
10. Notifications → **Turn off on this device**: further events do not reach the
    phone; the bell still shows them.

### Android (Chrome)
1. Sign in as B in Chrome; optionally Install app / Add to Home screen.
2. Notifications → **Enable notifications** → Allow (status **On**,
   "Android · Chrome").
3. Repeat checks 4–9 above, including tapping a notification with the app
   closed (it opens the lead) and with it open on another page (it navigates).
4. In Android settings, revoke the site's notification permission and reload:
   status shows **Blocked** with guidance.

### Multiple devices, removal and clean-up
- Enable on a phone and a desktop browser for the same account: both receive
  each event; "Your devices" lists both.
- On the phone, **Remove** the desktop. On the desktop, reload, then sign out
  and back in: it stays **Off** and is not listed, and new events do not reach
  it. Tap **Enable notifications** on the desktop: it is listed again and
  receives the next event.
- Sign out on a device: it disappears from "Your devices".
- Clear site data / uninstall the Home Screen app on a device, trigger an
  event, then check `notification_deliveries`: that device's row ends as
  `skipped` with `subscription_expired` and the subscription is removed.

### Recovery (test project only)
- In the **test** database only, temporarily add a BEFORE INSERT trigger on
  `notification_events` that raises an error, submit a request, then drop the
  trigger: the request was saved immediately, and the next dispatcher run
  reports `recovered: 1` and delivers it.

### Bell
- Unread count increases with each event; opening an item marks it read and
  opens the lead; "Mark all read" clears the count; staff of another shop never
  see these items.
