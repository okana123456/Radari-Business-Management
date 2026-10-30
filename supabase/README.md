# Radari Supabase setup

## SQL migrations

Run these in the Supabase SQL Editor, in order. Never edit a migration that has already been run; add a new numbered file instead.

| File | What it does |
|---|---|
| `migrations/0001_saas_foundation.sql` | Tenant tables, plans, Row Level Security |
| `migrations/0002_onboarding_and_subscriptions.sql` | Business provisioning, subscription activation, reminders |
| `migrations/0003_pos_checkout.sql` | Product categories, first checkout function, Realtime for products |
| `migrations/0004_business_management.sql` | Staff roles, hardened checkout, stock audit trail, void, purchases, expenses, customers and credit, suppliers, staff invitations, settings, reports, payment verification columns |
| `migrations/0005_operations_and_accounting.sql` | Card and split payments, discounts and price floor, loyalty points, sell by serving, batches and expiry, tax categories, credit due dates, creditors, categories, chart of accounts and journal, M-Pesa and branding settings, extended reports |

Check what is already applied:

```sql
select proname from pg_proc
where proname in ('complete_pos_sale', 'void_sale', 'business_report');
```

- `complete_pos_sale` only → 0003 is applied, 0004 is not.
- All three → 0004 is applied.

0004 runs inside a single transaction and can safely be run again.

**Order matters:** run 0004 **before** deploying the new frontend, because the new screens use its tables and functions. The old frontend keeps working after 0004, except that credit sales now require a customer.

## Edge Functions

| Function | JWT verification | Purpose |
|---|---|---|
| `initiate-subscription-payment` | Off (validates the user itself) | Owner starts an M-Pesa STK Push |
| `daraja-callback` | Off (Safaricom calls it) | Receives the result, **confirms it with the Daraja STK Query API**, then activates 30 days |
| `subscription-maintenance` | Off (requires `x-cron-secret`) | Finishes unverified payments, expires abandoned requests, moves expired subscriptions to grace or suspended |

Each `index.ts` is standalone, so you can paste it into the Dashboard editor or deploy it with the CLI:

```sh
supabase functions deploy initiate-subscription-payment --no-verify-jwt
supabase functions deploy daraja-callback --no-verify-jwt
supabase functions deploy subscription-maintenance --no-verify-jwt
```

## Secrets

Set these in **Supabase Dashboard → Edge Functions → Secrets**. Never commit them, and never put them in Vercel.

```text
DARAJA_ENV=production
DARAJA_CONSUMER_KEY=
DARAJA_CONSUMER_SECRET=
DARAJA_SHORTCODE=
DARAJA_PASSKEY=
DARAJA_CALLBACK_URL=https://byukapauihmoshvgkzot.supabase.co/functions/v1/daraja-callback
SUBSCRIPTION_CRON_SECRET=<long random value>
```

`subscription-maintenance` accepts either `SUBSCRIPTION_CRON_SECRET` or the older `CRON_SECRET`.

## Scheduling

Call `subscription-maintenance` every 15 minutes (it verifies pending M-Pesa payments as well as expiring subscriptions). Send the secret in the `x-cron-secret` header, and keep it in Supabase Vault rather than writing it directly in SQL:

```sql
select cron.schedule('radari-maintenance', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://byukapauihmoshvgkzot.supabase.co/functions/v1/subscription-maintenance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'subscription_cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);
```

## Auth settings

- **URL Configuration → Redirect URLs:** add `https://radari-business.vercel.app/login` and `https://radari-business.vercel.app/reset-password`.
- Keep email confirmation on. Staff invitations are matched only against confirmed email addresses.

## Tests

`npm run test:db` runs every migration against an in-memory Postgres (PGlite) and checks checkout, stock, void, credit, purchases, reports, roles, subscription enforcement and tenant isolation.
