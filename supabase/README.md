# Radari Supabase setup

## SQL files to run

Run these files in the Supabase SQL Editor in this exact order:

1. `migrations/0001_saas_foundation.sql`
2. `migrations/0002_onboarding_and_subscriptions.sql`

The first migration creates the tenant-safe POS tables and Row Level Security. The second adds account provisioning, subscription enforcement, payment activation, reminders and expiry processing.

## Edge Functions

- `initiate-subscription-payment` — authenticated owner starts an M-Pesa STK Push.
- `daraja-callback` — public Safaricom callback; validates the stored checkout request and activates 30 days.
- `subscription-maintenance` — protected daily task that moves expired subscriptions into grace or suspension and creates reminder records.

Deploy from the project root after linking the Supabase CLI:

```sh
supabase functions deploy initiate-subscription-payment
supabase functions deploy daraja-callback --no-verify-jwt
supabase functions deploy subscription-maintenance --no-verify-jwt
```

## Secrets

Set these in **Supabase Dashboard → Edge Functions → Secrets**:

```text
DARAJA_ENV=sandbox
DARAJA_CONSUMER_KEY=
DARAJA_CONSUMER_SECRET=
DARAJA_SHORTCODE=
DARAJA_PASSKEY=
DARAJA_CALLBACK_URL=https://YOUR_PROJECT.supabase.co/functions/v1/daraja-callback
CRON_SECRET=generate-a-long-random-value
```

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to deployed functions. Never put the service-role key or Daraja credentials in the website or GitHub.

## Scheduling

After deploying `subscription-maintenance`, schedule one daily HTTP call from Supabase Cron. Send the configured `CRON_SECRET` in the `x-cron-secret` header. Use Supabase Vault for that secret rather than writing it directly in SQL.

