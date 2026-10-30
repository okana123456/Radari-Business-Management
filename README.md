# Radari POS

Radari POS is a multi-business SaaS point-of-sale and business management platform for Kenyan businesses (KSh 1,500 per 30 days, paid by M-Pesa).

Production: https://radari-business.vercel.app. Vercel deploys every push to `main`.

## Features

- Till: barcode or SKU search, cash, M-Pesa and credit sales, idempotent checkout, printable receipts
- Overview dashboard: today's sales, profit, expenses, stock value, low stock, money owed both ways
- Inventory: products, categories, SKU and barcode, VAT, margins, stock adjustments, full stock audit trail
- Sales history: filters, receipt reprint, void with stock restoration
- Expenses, customers and credit, suppliers and purchases (weighted average cost)
- Staff invitations with roles: owner, admin, stock manager, cashier, accountant
- Reports: revenue, gross and net profit, VAT, best sellers, payment methods, expenses, CSV export
- Subscription status, renewal reminders and M-Pesa renewal; business and receipt settings

## Architecture

- React + TypeScript + Vite single-page app (`src/`), lazy-loaded pages
- Supabase is the only data store. Every business-owned table has `business_id`, indexes and Row Level Security.
- Money and stock changes run inside database functions with row locks. Prices, costs and totals always come from the database, never the browser.
- Edge Functions handle Daraja. Secrets live only in Supabase Edge Function Secrets.

See [`supabase/README.md`](supabase/README.md) for migrations, functions, secrets and scheduling.

## Local setup

1. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never add a service-role key.
2. `npm install`
3. `npm run dev`
4. `npm run build`: type-check and production build
5. `npm run test:db`: database tests (no Supabase connection needed)
