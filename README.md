# Radari POS

Radari POS is a multi-business SaaS point-of-sale and business management platform for Kenyan businesses.

## Current foundation

- React, TypeScript and Vite web application
- Supabase Auth and PostgreSQL integration point
- Multi-tenant schema with Row Level Security
- Subscription and M-Pesa payment records
- KSh 1,500 plan seeded by the first migration

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add the new Supabase project URL and publishable key.
3. Run the SQL migration in `supabase/migrations/0001_saas_foundation.sql`.
4. Install packages with `npm install`.
5. Start with `npm run dev`.

Daraja credentials belong in Supabase Edge Function Secrets. Never put them in Vite environment variables or commit them to GitHub.

