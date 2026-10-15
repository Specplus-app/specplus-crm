# Notifications: email, staff Web Push and in-app bell

One pipeline feeds every channel. Nothing on this branch has been deployed or
applied to any hosted database; the steps below are the manual production work.

## How it works

```
customer / staff action ──► lead_events (existing audit trail, same transaction)
                               │ AFTER INSERT trigger (exception-isolated)
                               ▼
                         notification_events ──► notifications (in-app bell, per staff user)
                               │
                               ▼
                    notification_deliveries (one row per channel × recipient)
                               │ claim (lease + authorization re-check)
                               ▼
              notification-dispatch Edge Function (every minute, via pg_cron)
                 ├─ email → Resend (Idempotency-Key per delivery)
                 └─ push  → browser push service (VAPID, aes128gcm encrypted)
                               │ complete (sent / retry / failed / gone)
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
  anything undelivered after 24 hours is abandoned (`failed`, "expired").
  Expired push subscriptions (HTTP 404/410) are deleted.
- **Duplicates**: one notification event per audit event, one delivery per
  channel and recipient (unique constraints), leases so only one worker sends a
  delivery, Resend `Idempotency-Key` and push `Topic` per delivery/event.
- **Isolation**: a notification failure is logged as a warning and never fails
  or rolls back the submission, message, approval or date request.
- **History**: only events after the migration is applied are notified.
- **Flood protection**: at most one customer-message email per lead per 10
  minutes and 50 new-request emails per shop per hour (bell and push still
  record everything).
- **Privacy**: lock-screen text is generic ("New request", "A customer sent a
  message about a quote") — no names, vehicles or message bodies. Emails never
  include message bodies; recipients follow the link. Push payloads are
  end-to-end encrypted. The service worker (`/push-sw.js`) has no fetch handler
  and caches nothing. The old caching `/sw.js` is replaced by a version that
  clears its caches and unregisters itself.

## Required infrastructure and secrets

No paid services are needed: Resend is already in use, Web Push uses the
browsers' free push services, and `pg_cron`, `pg_net` and Vault are included
Supabase extensions.

| Where | Name | Purpose |
|---|---|---|
| Edge Function secret | `RESEND_API_KEY` | Existing Resend key (already set for send-quote) |
| Edge Function secret | `RESEND_FROM_EMAIL` / `NOTIFICATION_FROM_EMAIL` (optional) | Sender address on the verified Resend domain; defaults to `quotes@specplus.app` |
| Edge Function secret | `NOTIFICATION_DISPATCH_SECRET` | Random string, at least 32 characters; only the scheduler knows it |
| Edge Function secret | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair (base64url, generated once) |
| Edge Function secret | `VAPID_SUBJECT` | Contact for push services, e.g. `mailto:` an operations address |
| Edge Function secret | `CRM_ORIGIN` (optional) | Link base for shop emails; defaults to `https://crm.specplus.app` |
| Edge Function secret | `PUBLIC_QUOTE_ORIGIN` (optional) | Link base for customer emails; defaults to `https://quotes.specplus.app` |
| Vercel env (build-time) | `VITE_VAPID_PUBLIC_KEY` | Same value as `VAPID_PUBLIC_KEY` (public, not secret). Without it the app shows "not configured" and only email + bell work |
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

## Manual deployment steps (not performed)

Preview deployments currently share the production database. Once the migration
and scheduler are live, activity in any environment produces real
notifications to real shops and customers. Coordinate before step 4.

1. Apply `supabase/migrations/20261014120000_add_notifications.sql`.
2. Set the Edge Function secrets above, then deploy `notification-dispatch`
   (config.toml sets `verify_jwt = false`; the function requires the secret
   header instead and accepts no recipients or content).
3. Set `VITE_VAPID_PUBLIC_KEY` in Vercel and redeploy the frontend.
4. Store the dispatch secret in Vault and schedule the dispatcher (replace the
   placeholder; do not commit the value):

   ```sql
   select vault.create_secret('<NOTIFICATION_DISPATCH_SECRET value>', 'notification_dispatch_secret');

   select cron.schedule('notification-dispatch', '* * * * *', $$
     select net.http_post(
       url := 'https://brzgvpissnewfkhblpvs.supabase.co/functions/v1/notification-dispatch',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-notification-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notification_dispatch_secret')
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 30000
     );
   $$);
   ```

   Until this runs, events are queued (and shown in the bell) but no email or
   push is sent. Queued work older than 24 hours is abandoned, not sent late.

5. Monitor: `select channel, status, last_error, count(*) from notification_deliveries group by 1, 2, 3;`

## Real-device acceptance checks

Use a test shop with a test contact email, a test customer email you control,
and two staff accounts (A and B) in that shop.

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

### Multiple devices and clean-up
- Enable on a phone and a desktop browser for the same account: both receive
  each event; "Your devices" lists both. **Remove** the desktop from the phone:
  the desktop stops receiving pushes.
- Sign out on a device: it disappears from "Your devices".
- Clear site data / uninstall the Home Screen app on a device, trigger an
  event, then check `notification_deliveries`: that device's row ends as
  `skipped` with `subscription_expired` and the subscription is removed.

### Bell
- Unread count increases with each event; opening an item marks it read and
  opens the lead; "Mark all read" clears the count; staff of another shop never
  see these items.
